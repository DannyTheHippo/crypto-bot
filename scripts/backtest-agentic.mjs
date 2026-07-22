#!/usr/bin/env node
// LLM-in-the-loop walk-forward backtest runner —
// `node scripts/backtest-agentic.mjs --symbol BTC/USDT --max-usd 3 [options]`.
//
// Thin CLI wrapper: parses args, resolves the OHLCV cache file (test/backtest/fetch-data.mjs's
// convention) and the playbook content, then spawns
// `vitest run test/backtest/agentic-replay-runner.spec.ts` with everything threaded through
// BACKTEST_AGENTIC_* env vars — that spec file is the actual call site of runAgenticReplay
// (test/backtest/agentic-replay.ts). See that spec's own header for why: agentic-replay.ts has no
// compiled dist output (the whole test/backtest/ research tree only runs through vitest's on-the-fly
// TS transform), so a plain `node`-executed .mjs cannot import it directly.
//
// Data loading: this script does NOT fetch OHLCV itself (a network call this script wasn't obviously
// asked to make, on top of the LLM budget it IS asked to spend) — if the cache file for
// <symbol>-<timeframe> is missing, it prints the exact `node test/backtest/fetch-data.mjs ...`
// command to run and exits 1. Run that command once, then re-invoke this script.
//
// PER-MODEL ROUTING (--model / --model-routes / --token-prices): the routes/prices JSON blobs use the
// same shapes the eval lane's AGENTIC_EVAL_MODEL_ROUTES_JSON / AGENTIC_TOKEN_PRICES_JSON carry, and
// are threaded through as BACKTEST_AGENTIC_* env vars like every other option. Known-good kimi route:
//   --model kimi-k3 \
//   --model-routes '{"kimi-k3":{"baseUrl":"https://api.moonshot.ai/anthropic","apiKeyEnv":"MOONSHOT_API_KEY","callDelayMs":5000}}' \
//   --token-prices '{"kimi-k3":{"inputPerMtok":"3","outputPerMtok":"15"}}'
//
// KEYS are read from env ONLY (never accepted as a flag, never printed — the config summary below
// names the VARIABLE, and whether it is set, never a value). A model whose route names its own
// baseUrl must name its own apiKeyEnv: that key, not ANTHROPIC_API_KEY, is what the run needs, so the
// Anthropic org key is never sent to a third-party host. With the required key missing this script
// prints the resolved config and REFUSES to spend (exit 1) rather than spawning vitest — the dry-run
// path an operator uses to check what a run would do before paying for it.
import { existsSync, readFileSync, writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DATA_DIR = join(REPO_ROOT, 'test', 'backtest', 'data');

// Mirrors agentic-replay.ts's EARLIEST_ALLOWED_ISO — keep in sync (that module re-checks this floor
// independently as defense in depth; this script's clamp is the primary enforcement point an operator
// actually sees).
const EARLIEST_ALLOWED_ISO = '2026-02-01T00:00:00.000Z';
const EARLIEST_ALLOWED_MS = Date.parse(EARLIEST_ALLOWED_ISO);

const INTERVAL_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

function usageError(message) {
  console.error(`backtest:agentic: ${message}`);
  console.error(
    'usage: node scripts/backtest-agentic.mjs --symbol <SYM> --max-usd <usd> [--timeframe 4h] ' +
      '[--from 2026-02-01] [--to <iso>] [--playbook-file <path>] [--model claude-sonnet-5] ' +
      "[--model-routes '<json>'] [--token-prices '<json>'] --out <scorecard.json>",
  );
  process.exitCode = 1;
}

// Which env var must hold THIS model's key. A per-model route naming its own baseUrl must name its
// own apiKeyEnv (test/shared/model-routing.ts's fail-closed rule) — returning null there would let
// the run fall through to the Anthropic org key, so an incomplete route is reported as the missing
// apiKeyEnv it is. Malformed JSON is left to the engine's own zod parse to reject with detail.
function requiredKeyEnvFor(model, routesJson) {
  if (!routesJson) return 'ANTHROPIC_API_KEY';
  let routes;
  try {
    routes = JSON.parse(routesJson);
  } catch {
    return 'ANTHROPIC_API_KEY';
  }
  const route = routes?.[model];
  if (route?.apiKeyEnv) return route.apiKeyEnv;
  if (route?.baseUrl) return '<missing apiKeyEnv in --model-routes for this model>';
  return 'ANTHROPIC_API_KEY';
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    out[key] = argv[i + 1];
    i++;
  }
  return out;
}

function safeName(symbol) {
  return symbol.replace(/[/:]/g, '');
}

// Refuses stale/missing dist rather than silently loading an out-of-date SEED_PLAYBOOK copy —
// mirrors playbook-candidate.mjs's loadValidatePlaybook freshness check exactly.
function loadSeedPlaybookContent() {
  const distPath = join(
    REPO_ROOT,
    'dist',
    'features',
    'trading',
    'agentic',
    'agentic-strategy.module.js',
  );
  const srcPath = join(
    REPO_ROOT,
    'src',
    'features',
    'trading',
    'agentic',
    'agentic-strategy.module.ts',
  );
  if (!existsSync(distPath)) {
    console.error(
      `backtest:agentic: ${distPath} not found — run pnpm build first, or pass --playbook-file explicitly.`,
    );
    process.exitCode = 1;
    return null;
  }
  const distMtimeMs = statSync(distPath).mtimeMs;
  const srcMtimeMs = existsSync(srcPath) ? statSync(srcPath).mtimeMs : 0;
  if (srcMtimeMs > distMtimeMs) {
    console.error(
      `backtest:agentic: ${distPath} is older than its source — run pnpm build first, or pass --playbook-file explicitly.`,
    );
    process.exitCode = 1;
    return null;
  }
  const require = createRequire(import.meta.url);
  return require(distPath).SEED_PLAYBOOK.content;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbol = args.symbol;
  if (!symbol) {
    usageError('missing --symbol');
    return;
  }
  const timeframe = args.timeframe ?? '4h';
  if (!(timeframe in INTERVAL_MS)) {
    usageError(
      `--timeframe must be one of ${Object.keys(INTERVAL_MS).join('/')}, got ${timeframe}`,
    );
    return;
  }
  const maxUsd = args['max-usd'];
  if (!maxUsd) {
    usageError('missing --max-usd (required — no default, this is a real $ spend cap)');
    return;
  }
  const outFile = args.out;
  if (!outFile) {
    usageError('missing --out <scorecard.json>');
    return;
  }
  const model = args.model ?? 'claude-sonnet-5';
  // Flag wins over an already-exported env var, so a one-off routed run needs no shell export.
  const modelRoutesJson =
    args['model-routes'] ?? process.env.BACKTEST_AGENTIC_MODEL_ROUTES_JSON ?? '';
  const tokenPricesJson =
    args['token-prices'] ?? process.env.BACKTEST_AGENTIC_TOKEN_PRICES_JSON ?? '';

  const fromArg = args.from ?? '2026-02-01';
  let fromMs = Date.parse(fromArg);
  if (Number.isNaN(fromMs)) {
    usageError(`--from is not a parseable date: ${fromArg}`);
    return;
  }
  if (fromMs < EARLIEST_ALLOWED_MS) {
    console.warn(
      `backtest:agentic: --from ${fromArg} precedes the training-cutoff floor ${EARLIEST_ALLOWED_ISO} — clamping up to the floor (memorization confound; see agentic-replay.ts's header).`,
    );
    fromMs = EARLIEST_ALLOWED_MS;
  }
  const toArg = args.to ?? new Date().toISOString();
  const toMs = Date.parse(toArg);
  if (Number.isNaN(toMs)) {
    usageError(`--to is not a parseable date: ${toArg}`);
    return;
  }
  if (toMs <= fromMs) {
    usageError(
      `--to (${toArg}) must be after the effective --from (${new Date(fromMs).toISOString()})`,
    );
    return;
  }

  // Resolved-config summary FIRST, before any file/playbook resolution, so the keyless dry-run below
  // always shows exactly what a paid run would do. Never prints a key value — only the env VARIABLE
  // the key must come from, and whether it is currently set.
  const keyEnvName = requiredKeyEnvFor(model, modelRoutesJson);
  const keyPresent = !!process.env[keyEnvName];
  console.log(
    `backtest:agentic: symbol=${symbol} timeframe=${timeframe} from=${new Date(fromMs).toISOString()} ` +
      `to=${new Date(toMs).toISOString()} maxUsd=${maxUsd} model=${model} out=${outFile}`,
  );
  console.log(
    `backtest:agentic: keyEnv=${keyEnvName} keyPresent=${keyPresent} ` +
      `modelRoutes=${modelRoutesJson ? 'set' : 'default (api.anthropic.com)'} ` +
      `tokenPrices=${tokenPricesJson ? 'set' : 'default table'}`,
  );
  if (!keyPresent) {
    console.error(
      `backtest:agentic: ${keyEnvName} is not set — printed the resolved config above and refusing ` +
        'to spend. Export that variable and re-run.',
    );
    process.exitCode = 1;
    return;
  }

  const ohlcvFile = join(DATA_DIR, `ohlcv-${safeName(symbol)}-${timeframe}.json`);
  if (!existsSync(ohlcvFile)) {
    const intervalMs = INTERVAL_MS[timeframe];
    const suggestedBars = Math.max(200, Math.ceil((toMs - fromMs) / intervalMs) + 50);
    console.error(
      `backtest:agentic: no cached OHLCV at ${ohlcvFile}. Fetch it first:\n` +
        `  node test/backtest/fetch-data.mjs ${symbol} ${timeframe} ${suggestedBars}\n` +
        'then re-run this command.',
    );
    process.exitCode = 1;
    return;
  }

  let playbookContent;
  if (args['playbook-file']) {
    try {
      playbookContent = readFileSync(args['playbook-file'], 'utf8');
    } catch (err) {
      usageError(
        `could not read --playbook-file ${args['playbook-file']}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  } else {
    playbookContent = loadSeedPlaybookContent();
    if (playbookContent === null) return; // loadSeedPlaybookContent already printed the reason
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'backtest-agentic-'));
  const playbookFile = join(scratchDir, 'playbook.txt');
  writeFileSync(playbookFile, playbookContent);

  const env = {
    ...process.env,
    BACKTEST_AGENTIC_RUN: '1',
    BACKTEST_AGENTIC_SYMBOL: symbol,
    BACKTEST_AGENTIC_TIMEFRAME: timeframe,
    BACKTEST_AGENTIC_FROM_MS: String(fromMs),
    BACKTEST_AGENTIC_TO_MS: String(toMs),
    BACKTEST_AGENTIC_MAX_USD: maxUsd,
    BACKTEST_AGENTIC_MODEL: model,
    BACKTEST_AGENTIC_OHLCV_FILE: ohlcvFile,
    BACKTEST_AGENTIC_PLAYBOOK_FILE: playbookFile,
    BACKTEST_AGENTIC_OUT: outFile,
    // Empty string ⇒ the engine treats it as absent (default route / default rate table); set only
    // when non-empty so an exported-but-blank var never looks like an explicit override.
    ...(modelRoutesJson ? { BACKTEST_AGENTIC_MODEL_ROUTES_JSON: modelRoutesJson } : {}),
    ...(tokenPricesJson ? { BACKTEST_AGENTIC_TOKEN_PRICES_JSON: tokenPricesJson } : {}),
  };

  // Invoke the local vitest CLI directly via the current Node binary rather than `pnpm exec vitest`:
  // under corepack (this repo's package manager), a bare `pnpm` is not on PATH for a spawned child,
  // so spawnSync('pnpm', …) fails ENOENT and silently no-ops (result.status null). process.execPath +
  // the resolved vitest.mjs entry is PATH-independent.
  // vitest's package `exports` doesn't expose its bin, so resolve the package.json (which IS
  // exported) and read its `bin.vitest` entry relative to the package dir.
  const vitestReq = createRequire(import.meta.url);
  const vitestPkgPath = vitestReq.resolve('vitest/package.json');
  const vitestBin = JSON.parse(readFileSync(vitestPkgPath, 'utf8')).bin.vitest;
  const vitestEntry = join(dirname(vitestPkgPath), vitestBin);
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', 'test/backtest/agentic-replay-runner.spec.ts'],
    { cwd: REPO_ROOT, env, stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`backtest:agentic: failed to spawn vitest: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

main().catch((err) => {
  console.error(
    `backtest:agentic: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
