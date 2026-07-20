#!/usr/bin/env node
// Y2 deterministic health-sweep RUNNER — one read-only pass producing a UTC-stamped digest.
// `node scripts/loop-sweep.mjs` (or `pnpm loop:sweep`).
//
// What it does, in order (loop-mechanism-learnings-2026-07.md §D):
//   1. Opens with host duty-cycle state (pmset/boottime/uptime) — the sleep/wake edge is the
//      highest-risk window, quantified before any counter is interpreted.
//   2. Per lane, provenance FIRST: container health + RestartCount + StartedAt (docker inspect),
//      bootId (boot_info metric), working-tree git tip — recorded before a single counter is read.
//   3. Liveness probes: agentic_consult_gate_total by outcome, agent_decisions count + latest
//      created_at, fills, reconciliations tail, kill-switch state, ws forced-reconnects, RSS, and the
//      LLM cost-vs-breaker proximity. Every stack read goes through loop-transport.mjs (one GCP-lift
//      seam) and returns {ok,value}|{ok,error} — a failed probe is reported, never thrown.
//   4. Hands {prev watermark, cur probes} to the PURE core (loop-sweep-core.mjs), which derives the
//      bootId-pinned deltas, the fired alarms, and the annotations — deltas only when bootId matches.
//   5. Writes the digest JSON + updates the watermark UNDER reports/loop/digests/ ONLY (single writer
//      helper), and renders the markdown digest to stdout.
//
// Measurement fails OPEN: probe errors yield a partial digest with the failures named; the process
// exits 0 unless the tool itself crashes. It never mutates the stack (read-only transport).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  dockerPs,
  dockerInspect,
  dockerLogsTail,
  psql,
  promQuery,
  hostState,
} from './loop-transport.mjs';
import {
  computeSweep,
  extractCounters,
  costBreakerLimitFor,
  COST_BREAKER_USD,
} from './loop-sweep-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DIGESTS_DIR = join(REPO_ROOT, 'reports', 'loop', 'digests');
const WATERMARK_PATH = join(DIGESTS_DIR, '.watermark.json');
const ERROR_LOG_TAIL = 3000;
const PINO_WARN_LEVEL = 40; // pino level>=40 = warn/error/fatal (§ error-scan)

// The lanes this sweep knows how to read, with their compose container names (docker compose default
// `<project>-<service>-N`). The perp lane is included only when its app container is actually up.
const LANES = {
  spot: { app: 'crypto-bot-app-1', label: 'spot' },
  perp: { app: 'crypto-bot-app-perp-1', label: 'perp' },
};

// ── the ONLY writer: refuses any path escaping reports/loop/digests/ ─────────────────────────────
function writeUnderDigests(relName, content) {
  const target = resolve(DIGESTS_DIR, relName);
  if (target !== DIGESTS_DIR && !target.startsWith(DIGESTS_DIR + sep)) {
    throw new Error(`refusing to write outside the digests dir: ${target}`);
  }
  mkdirSync(DIGESTS_DIR, { recursive: true });
  writeFileSync(target, content);
  return target;
}

// ── small local provenance read (host repo state, NOT stack access — stays local after a GCP lift) ─
function gitTip() {
  const res = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

// ── prometheus instant-vector parsing ────────────────────────────────────────────────────────────
// promtool prints one line per series: `name{label="v",...} => <value> @[<ts>]`.
function parsePromSeries(res) {
  if (!res.ok) return { ok: false, error: res.error };
  const series = [];
  for (const raw of res.value.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const valueMatch = line.match(/=>\s*([-\d.eE+]+)\s*@/);
    if (!valueMatch) continue;
    const value = Number(valueMatch[1]);
    const labels = {};
    const labelBlock = line.match(/\{([^}]*)\}/);
    if (labelBlock && labelBlock[1]) {
      for (const pair of labelBlock[1].split(',')) {
        const m = pair.match(/([^=]+)="([^"]*)"/);
        if (m) labels[m[1].trim()] = m[2];
      }
    }
    series.push({ labels, value });
  }
  return { ok: true, value: series };
}

function promScalar(res) {
  const parsed = parsePromSeries(res);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value.length === 0) return { ok: false, error: 'empty instant vector (no series)' };
  return { ok: true, value: parsed.value[0].value };
}

// ── psql single-row `-Atc` parsing: pipe-delimited columns on one line ───────────────────────────
function parsePsqlRow(res) {
  if (!res.ok) return { ok: false, error: res.error };
  const line = res.value.split('\n').find((l) => l.trim().length > 0);
  if (line === undefined) return { ok: false, error: 'empty result set' };
  return { ok: true, value: line.split('|') };
}

// ── per-lane provenance + liveness probes ────────────────────────────────────────────────────────
function gatherLane(laneKey) {
  const lane = LANES[laneKey];
  const probes = {};

  // Provenance FIRST (§D): container health, RestartCount, StartedAt.
  let containerHealthy = false;
  let restartCount = null;
  let startedAt = null;
  const inspect = dockerInspect(lane.app);
  if (inspect.ok) {
    try {
      const info = JSON.parse(inspect.value)[0];
      const state = (info && info.State) || {};
      const health = (state.Health && state.Health.Status) || null;
      containerHealthy = health ? health === 'healthy' : state.Running === true;
      restartCount = Number.isFinite(info && info.RestartCount) ? info.RestartCount : null;
      startedAt = (state && state.StartedAt) || null;
    } catch (err) {
      probes.inspect = { ok: false, error: `inspect parse: ${String(err)}` };
    }
  } else {
    probes.inspect = inspect;
  }

  // bootId — from the boot_info metric label (metrics-first, §D: survives a NOOP_LOGGER the logs
  // do not). One series carries boot_id.
  let bootId = null;
  const bootInfo = parsePromSeries(promQuery('boot_info', laneKey));
  if (bootInfo.ok && bootInfo.value.length > 0) {
    bootId = bootInfo.value[0].labels.boot_id || null;
  }

  // agent_decisions liveness (count + latest created_at as epoch ms).
  probes.decides = (() => {
    const row = parsePsqlRow(
      psql(
        laneKey,
        'select count(*), coalesce((extract(epoch from max(created_at))*1000)::bigint,0) from agent_decisions',
        { cwd: REPO_ROOT },
      ),
    );
    if (!row.ok) return row;
    const count = Number(row.value[0]);
    const latest = Number(row.value[1]);
    if (!Number.isFinite(count)) return { ok: false, error: `unparseable count: ${row.value[0]}` };
    return {
      ok: true,
      value: { count, latestCreatedAtMs: Number.isFinite(latest) ? latest : null },
    };
  })();

  // consult-gate total + by-outcome breakdown (Prometheus, log-independent backstop).
  const gateSeries = parsePromSeries(
    promQuery('sum by (outcome) (agentic_consult_gate_total)', laneKey),
  );
  let consultByOutcome = null;
  probes.consultGate = (() => {
    if (!gateSeries.ok) return gateSeries;
    let total = 0;
    consultByOutcome = {};
    for (const s of gateSeries.value) {
      total += s.value;
      if (s.labels.outcome) consultByOutcome[s.labels.outcome] = s.value;
    }
    return { ok: true, value: { total } };
  })();

  probes.fills = (() => {
    const row = parsePsqlRow(psql(laneKey, 'select count(*) from fills', { cwd: REPO_ROOT }));
    if (!row.ok) return row;
    const count = Number(row.value[0]);
    return Number.isFinite(count)
      ? { ok: true, value: { count } }
      : { ok: false, error: `unparseable fills count: ${row.value[0]}` };
  })();

  // reconciliations: row count + latest verdict (CLEAN/MISMATCH/HALT) for the reconcile-halt +
  // journal-silence checks.
  probes.reconcile = (() => {
    const row = parsePsqlRow(
      psql(
        laneKey,
        "select count(*), coalesce((select result from reconciliations order by id desc limit 1),'NONE') from reconciliations",
        { cwd: REPO_ROOT },
      ),
    );
    if (!row.ok) return row;
    const count = Number(row.value[0]);
    if (!Number.isFinite(count))
      return { ok: false, error: `unparseable reconcile count: ${row.value[0]}` };
    return { ok: true, value: { count, latestResult: row.value[1] } };
  })();

  // kill-switch STATE (metric, never /health — §C.1: /health/ready hardcoded RUNNING once).
  probes.killSwitch = (() => {
    const s = parsePromSeries(promQuery('kill_switch_state == 1', laneKey));
    if (!s.ok) return s;
    const active = s.value.find((x) => x.value === 1);
    return active
      ? { ok: true, value: { state: active.labels.state || 'unknown' } }
      : { ok: false, error: 'no kill_switch_state series == 1 (state indeterminate)' };
  })();

  // ws forced reconnects (recreation proxy) + RSS trend, both via Prometheus.
  probes.wsRecreations = (() => {
    const v = promScalar(promQuery('sum(market_stream_forced_reconnects_total)', laneKey));
    return v.ok ? { ok: true, value: { count: v.value } } : v;
  })();
  probes.rss = (() => {
    const v = promScalar(promQuery('process_resident_memory_bytes', laneKey));
    return v.ok ? { ok: true, value: { bytes: v.value } } : v;
  })();

  // Cost vs breaker: primary signal is the app's own agentic_budget_remaining_usd gauge (spend =
  // cap − remaining), which needs NO offline pricing — the three-ledger discipline (§C.7) prefers the
  // app's priced ledger over re-deriving tokens×rates here. The DB-token cross-check ships verified:false
  // (token→USD needs the env-configured AGENTIC_TOKEN_PRICE_* rates + the live model mix, neither
  // knowable from this pass), so it annotates rather than drives the alarm.
  const limit = costBreakerLimitFor(laneKey);
  probes.cost = (() => {
    const remaining = promScalar(promQuery('agentic_budget_remaining_usd', laneKey));
    if (!remaining.ok) return remaining;
    const spendUsd = Math.max(0, limit - remaining.value);
    return { ok: true, value: { spendUsd, remainingUsd: remaining.value, verified: true } };
  })();

  // Error/warn scan: tail (never --since), pino level>=40, top-5 distinct msg prefixes.
  const errorScan = scanErrors(lane.app);

  return {
    bootId,
    containerHealthy,
    restartCount,
    startedAt,
    probes,
    consultByOutcome,
    errorScan,
  };
}

// pino level>=40 lines from a bounded tail; rank the 5 most common message prefixes so the digest
// carries signal, not a raw log wall.
function scanErrors(container) {
  const res = dockerLogsTail(container, ERROR_LOG_TAIL);
  if (!res.ok) return { ok: false, error: res.error };
  const prefixCounts = new Map();
  let matched = 0;
  for (const raw of res.value.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isFinite(obj.level) || obj.level < PINO_WARN_LEVEL) continue;
    matched += 1;
    const msg = typeof obj.msg === 'string' ? obj.msg : '';
    const prefix = msg.slice(0, 48) || '(no msg)';
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const top = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([prefix, count]) => ({ prefix, count }));
  return { ok: true, value: { matched, scanned: ERROR_LOG_TAIL, top } };
}

function loadWatermark() {
  try {
    return JSON.parse(readFileSync(WATERMARK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// The next watermark: bootId + RestartCount + scalar counters per lane, plus the sweep timestamp.
function buildWatermark(sweptAtMs, lanes) {
  const out = { sweptAtMs, lanes: {} };
  for (const [laneKey, laneCur] of Object.entries(lanes)) {
    out.lanes[laneKey] = {
      bootId: laneCur.bootId,
      restartCount: laneCur.restartCount,
      counters: extractCounters(laneCur),
    };
  }
  return out;
}

function renderMarkdown({ sweptIso, host, git, lanes, result }) {
  const L = [];
  L.push(`# Loop health sweep — ${sweptIso}`);
  L.push('');
  L.push('## Host state');
  L.push(`- power: ${host.powerSource ?? 'n/a'}`);
  L.push(`- boot time: ${host.bootTime ?? 'n/a'}`);
  L.push(`- uptime: ${host.uptime ?? 'n/a'}`);
  if (host.errors && host.errors.length > 0)
    L.push(`- host-read errors: ${host.errors.join('; ')}`);
  L.push(`- working-tree git tip: ${git ?? 'n/a'}`);
  L.push('');

  const alarms = result.alarms;
  L.push(`## Alarms (${alarms.length})`);
  if (alarms.length === 0) L.push('- none');
  for (const a of alarms) L.push(`- **${a.kind}** [${a.lane}] — ${a.detail}`);
  L.push('');

  L.push(`## Annotations (${result.annotations.length})`);
  if (result.annotations.length === 0) L.push('- none');
  for (const n of result.annotations) {
    const scope = n.lane ? `[${n.lane}${n.probe ? '.' + n.probe : ''}] ` : '';
    L.push(`- _${n.kind}_ ${scope}— ${n.detail}`);
  }
  L.push('');

  for (const [laneKey, laneCur] of Object.entries(lanes)) {
    L.push(`## Lane: ${laneKey}`);
    L.push(`- container healthy: ${laneCur.containerHealthy}`);
    L.push(`- bootId: ${laneCur.bootId ?? 'UNRESOLVED'}`);
    L.push(
      `- RestartCount: ${laneCur.restartCount ?? 'n/a'} · StartedAt: ${laneCur.startedAt ?? 'n/a'}`,
    );
    L.push(`- cost breaker: $${COST_BREAKER_USD[laneKey] ?? 'n/a'}/day`);
    const d = result.deltas[laneKey];
    L.push(
      `- deltas vs watermark: ${d ? JSON.stringify(d) : 'reset (boot changed or first sweep)'}`,
    );
    if (laneCur.consultByOutcome) {
      L.push(`- consult-gate by outcome: ${JSON.stringify(laneCur.consultByOutcome)}`);
    }
    const es = laneCur.errorScan;
    if (es.ok) {
      L.push(`- warn+ lines (tail ${es.value.scanned}): ${es.value.matched}`);
      for (const t of es.value.top) L.push(`  - ${t.count}× ${t.prefix}`);
    } else {
      L.push(`- error scan: probe_failed — ${es.error}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// One read-only pass: gather probes, run the pure core, persist the sweep JSON + advance the
// watermark, and return the digest object + rendered markdown. In-process callers (loop-collect.mjs)
// reuse this so a collector tick and a `pnpm loop:sweep` invocation share one code path — the watermark
// advances identically whether the interval driver is a human CLI run or the standing collector. A
// probe failure is data on the returned digest; only a tool-level crash throws (the CLI wrapper and
// the collector each decide how to surface that).
export function runSweep() {
  const sweptAtMs = Date.now();
  const sweptIso = new Date(sweptAtMs).toISOString();
  const host = hostState().value;
  const git = gitTip();

  // Which lanes are actually deployed — perp is behind a compose profile and often absent.
  const ps = dockerPs();
  const running = ps.ok ? ps.value : '';
  const lanes = {};
  for (const [laneKey, lane] of Object.entries(LANES)) {
    if (running.includes(lane.app)) {
      lanes[laneKey] = gatherLane(laneKey);
    }
  }

  const prev = loadWatermark();
  const cur = { sweptAtMs, lanes };
  const result = computeSweep({ prev, cur });

  if (Object.keys(lanes).length === 0) {
    result.annotations.push({
      kind: 'no_lanes',
      detail: ps.ok
        ? 'no known lane containers running (crypto-bot-app-1 / crypto-bot-app-perp-1 absent)'
        : `docker ps failed: ${ps.error}`,
    });
  }

  const digest = { sweptIso, sweptAtMs, git, host, lanes, result };

  const safeIso = sweptIso.replace(/[:.]/g, '-');
  const digestPath = writeUnderDigests(`sweep-${safeIso}.json`, JSON.stringify(digest, null, 2));
  writeUnderDigests('.watermark.json', JSON.stringify(buildWatermark(sweptAtMs, lanes), null, 2));

  const markdown = renderMarkdown({ sweptIso, host, git, lanes, result });
  return { digest, markdown, digestPath };
}

function main() {
  const { markdown, digestPath } = runSweep();
  process.stdout.write(markdown + '\n');
  process.stderr.write(`loop-sweep: digest written to ${digestPath}\n`);
}

// CLI entry-point guard: run the sweep ONLY when executed directly. An `import` (loop-collect.mjs
// reuses runSweep) must NOT fire a full blocking sweep as an import side effect.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // Only a crash of the tool ITSELF reaches here — every probe failure is captured as data upstream.
    process.stderr.write(`loop-sweep: FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  }
}
