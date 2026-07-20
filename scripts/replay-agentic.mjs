#!/usr/bin/env node
// R1 historical-replay PRACTICE HARNESS CLI —
// `node scripts/replay-agentic.mjs --symbol BTC/USDT --budget-usd 3 [options]`
// (dry run: `node scripts/replay-agentic.mjs --symbol BTC/USDT --budget-usd 0.01 --dry-run`).
//
// Thin CLI wrapper, mirroring scripts/backtest-agentic.mjs verbatim (see that file's header for the
// full rationale): it parses args, resolves the OHLCV cache file for a REAL run, then spawns
// `vitest run test/backtest/replay-agentic-runner.spec.ts` with everything threaded through
// REPLAY_AGENTIC_* env vars — that spec is the actual call site of runAgenticReplayR1
// (test/backtest/agentic-replay-r1.ts), which has no compiled dist output (the whole test/backtest/
// research tree only runs through vitest's on-the-fly TS transform), so a plain `node`-executed .mjs
// cannot import it directly.
//
// DRY RUN (--dry-run): the CI-safe path — the runner builds a synthetic fixture candle series, an
// in-memory journal, and a scripted (no-network) decide stub; no ANTHROPIC_API_KEY, no OHLCV cache,
// and no DB are required. A real run (no --dry-run) requires ANTHROPIC_API_KEY and a cached OHLCV
// file, and journals its synthetic `replay-<runId>` rows into the live agent_decisions table via
// DATABASE_URL — an owner/loop-triggered spend (~$30-80 at scale), NEVER run unattended.
//
// ANTHROPIC_API_KEY / DATABASE_URL are read from env only (never accepted as flags, never logged) —
// this script only checks presence before spawning vitest, which inherits them via the environment.
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DATA_DIR = join(REPO_ROOT, 'test', 'backtest', 'data');

// Mirrors agentic-replay-r1.ts's EARLIEST_ALLOWED_ISO — the memorization-cutoff floor the engine
// re-checks independently; this clamp is the operator-visible primary enforcement point.
const EARLIEST_ALLOWED_ISO = '2026-02-01T00:00:00.000Z';
const EARLIEST_ALLOWED_MS = Date.parse(EARLIEST_ALLOWED_ISO);

const INTERVAL_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

function usageError(message) {
  console.error(`replay:agentic: ${message}`);
  console.error(
    'usage: node scripts/replay-agentic.mjs --symbol <SYM> --budget-usd <usd> [--timeframe 15m] ' +
      '[--from 2026-02-01] [--to <iso>] [--days <n>] [--model <id>] [--run-id <id>] [--dry-run] ' +
      '[--playbook-file <path>] --out <report.json>',
  );
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'dry-run') {
      out[key] = true;
      continue;
    }
    out[key] = argv[i + 1];
    i++;
  }
  return out;
}

function safeName(symbol) {
  return symbol.replace(/[/:]/g, '');
}

// Refuses stale/missing dist rather than silently loading an out-of-date SEED_PLAYBOOK copy — mirrors
// backtest-agentic.mjs's loadSeedPlaybookContent freshness check exactly.
function loadSeedPlaybookContent() {
  const distPath = join(REPO_ROOT, 'dist', 'features', 'trading', 'agentic', 'agentic-strategy.module.js');
  const srcPath = join(REPO_ROOT, 'src', 'features', 'trading', 'agentic', 'agentic-strategy.module.ts');
  if (!existsSync(distPath)) {
    console.error(
      `replay:agentic: ${distPath} not found — run pnpm build first, or pass --playbook-file explicitly.`,
    );
    process.exitCode = 1;
    return null;
  }
  const distMtimeMs = statSync(distPath).mtimeMs;
  const srcMtimeMs = existsSync(srcPath) ? statSync(srcPath).mtimeMs : 0;
  if (srcMtimeMs > distMtimeMs) {
    console.error(
      `replay:agentic: ${distPath} is older than its source — run pnpm build first, or pass --playbook-file explicitly.`,
    );
    process.exitCode = 1;
    return null;
  }
  const require = createRequire(import.meta.url);
  return require(distPath).SEED_PLAYBOOK.content;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args['dry-run'] === true;

  const symbol = args.symbol;
  if (!symbol) {
    usageError('missing --symbol');
    return;
  }
  const maxUsd = args['budget-usd'];
  if (!maxUsd) {
    usageError('missing --budget-usd (required — no default, this caps a real $ spend)');
    return;
  }
  if (!(Number(maxUsd) > 0)) {
    usageError(`--budget-usd must be a positive number, got ${maxUsd}`);
    return;
  }
  const outFile = args.out;
  if (!outFile) {
    usageError('missing --out <report.json>');
    return;
  }
  const timeframe = args.timeframe ?? '15m';
  if (!(timeframe in INTERVAL_MS)) {
    usageError(`--timeframe must be one of ${Object.keys(INTERVAL_MS).join('/')}, got ${timeframe}`);
    return;
  }
  // Model default order: --model, then AGENTIC_MODEL (the field the live decide path pins), then the
  // schema default. Never billed against a model other than the one under study.
  const model = args.model ?? process.env.AGENTIC_MODEL ?? 'claude-sonnet-5';
  const runId = args['run-id'] ?? `${safeName(symbol)}-${Date.now()}`;

  const fromArg = args.from ?? '2026-02-01';
  let fromMs = Date.parse(fromArg);
  if (Number.isNaN(fromMs)) {
    usageError(`--from is not a parseable date: ${fromArg}`);
    return;
  }
  if (fromMs < EARLIEST_ALLOWED_MS) {
    console.warn(
      `replay:agentic: --from ${fromArg} precedes the training-cutoff floor ${EARLIEST_ALLOWED_ISO} — clamping up (memorization confound; see agentic-replay-r1.ts's header).`,
    );
    fromMs = EARLIEST_ALLOWED_MS;
  }
  const intervalMs = INTERVAL_MS[timeframe];
  const toArg = args.to ?? (args.days ? new Date(fromMs + Number(args.days) * 86_400_000).toISOString() : new Date().toISOString());
  const toMs = Date.parse(toArg);
  if (Number.isNaN(toMs) || toMs <= fromMs) {
    usageError(`--to (${toArg}) must be a date after the effective --from (${new Date(fromMs).toISOString()})`);
    return;
  }

  const env = {
    ...process.env,
    REPLAY_AGENTIC_RUN: '1',
    REPLAY_AGENTIC_SYMBOL: symbol,
    REPLAY_AGENTIC_TIMEFRAME: timeframe,
    REPLAY_AGENTIC_FROM_MS: String(fromMs),
    REPLAY_AGENTIC_TO_MS: String(toMs),
    REPLAY_AGENTIC_MAX_USD: maxUsd,
    REPLAY_AGENTIC_MODEL: model,
    REPLAY_AGENTIC_RUN_ID: runId,
    REPLAY_AGENTIC_OUT: outFile,
    REPLAY_AGENTIC_DRY_RUN: dryRun ? '1' : '0',
  };

  if (dryRun) {
    // CI-safe path: synthetic fixture candles, in-memory journal, scripted decide — no key, no cache.
    console.log(
      `replay:agentic (dry-run): symbol=${symbol} timeframe=${timeframe} maxUsd=${maxUsd} model=${model} runId=${runId} out=${outFile}`,
    );
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      usageError('ANTHROPIC_API_KEY is required for a real run — refusing (use --dry-run for the no-network path).');
      return;
    }
    const ohlcvFile = join(DATA_DIR, `ohlcv-${safeName(symbol)}-${timeframe}.json`);
    if (!existsSync(ohlcvFile)) {
      const suggestedBars = Math.max(200, Math.ceil((toMs - fromMs) / intervalMs) + 50);
      console.error(
        `replay:agentic: no cached OHLCV at ${ohlcvFile}. Fetch it first:\n` +
          `  node test/backtest/fetch-data.mjs ${symbol} ${timeframe} ${suggestedBars}\n` +
          'then re-run this command.',
      );
      process.exitCode = 1;
      return;
    }
    env.REPLAY_AGENTIC_OHLCV_FILE = ohlcvFile;

    let playbookContent;
    if (args['playbook-file']) {
      try {
        playbookContent = readFileSync(args['playbook-file'], 'utf8');
      } catch (err) {
        usageError(`could not read --playbook-file ${args['playbook-file']}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      playbookContent = loadSeedPlaybookContent();
      if (playbookContent === null) return;
    }
    const scratchDir = mkdtempSync(join(tmpdir(), 'replay-agentic-'));
    const playbookFile = join(scratchDir, 'playbook.txt');
    writeFileSync(playbookFile, playbookContent);
    env.REPLAY_AGENTIC_PLAYBOOK_FILE = playbookFile;

    console.log(
      `replay:agentic: symbol=${symbol} timeframe=${timeframe} from=${new Date(fromMs).toISOString()} to=${new Date(toMs).toISOString()} maxUsd=${maxUsd} model=${model} runId=${runId} out=${outFile}`,
    );
  }

  // Invoke the local vitest CLI directly via the current Node binary (PATH-independent) rather than
  // `pnpm exec vitest` — same rationale as backtest-agentic.mjs's own spawn comment.
  const vitestReq = createRequire(import.meta.url);
  const vitestPkgPath = vitestReq.resolve('vitest/package.json');
  const vitestBin = JSON.parse(readFileSync(vitestPkgPath, 'utf8')).bin.vitest;
  const vitestEntry = join(dirname(vitestPkgPath), vitestBin);
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', 'test/backtest/replay-agentic-runner.spec.ts'],
    { cwd: REPO_ROOT, env, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`replay:agentic: failed to spawn vitest: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

main().catch((err) => {
  console.error(`replay:agentic: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
