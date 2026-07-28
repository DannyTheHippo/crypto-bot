#!/usr/bin/env node
// Y2 deterministic health-sweep RUNNER — one read-only pass producing a UTC-stamped digest.
// `node scripts/loop-sweep.mjs` (or `pnpm loop:sweep`).
//
// v3 single stack (2026-07-20 consolidation): exactly 4 containers (docker-compose.yml) —
// crypto-bot-{app,postgres,prometheus,grafana}-1, no `-perp` siblings, no compose profile. ONE
// process now runs both venues (spot binance + perp binanceusdm) against the ONE db and the ONE
// Prometheus, with venue-labeled metrics distinguishing the two where it matters (market_channel_
// staleness_seconds{venue}, reconciliation_runs_total{venue}, venue_free_cash_usdt{venue}, ...). The
// v2 per-lane split (separate container/db/Prometheus per lane) is gone — see loop-sweep-core.mjs's
// header for which checks stayed per-venue (reconciliations) vs collapsed to account-level.
//
// What it does, in order (loop-mechanism-learnings-2026-07.md §D):
//   1. Opens with host duty-cycle state (pmset/boottime/uptime) — the sleep/wake edge is the
//      highest-risk window, quantified before any counter is interpreted.
//   2. Provenance FIRST: container health + RestartCount + StartedAt (docker inspect), bootId
//      (boot_info metric), working-tree git tip — recorded before a single counter is read.
//   3. Liveness probes: agentic_consult_gate_total by outcome, agent_decisions count + latest
//      created_at, fills, per-venue reconciliations tail, kill-switch state, ws forced-reconnects,
//      RSS, and the LLM cost-vs-breaker proximity. Every stack read goes through loop-transport.mjs
//      (one GCP-lift seam) and returns {ok,value}|{ok,error} — a failed probe is reported, never thrown.
//   4. Hands {prev watermark, cur probes} to the PURE core (loop-sweep-core.mjs), which derives the
//      bootId-pinned deltas, the fired alarms, and the annotations — deltas only when bootId matches.
//   5. Writes the digest JSON + updates the watermark UNDER research/loop/digests/ ONLY (single writer
//      helper), and renders the markdown digest to stdout.
//
// Measurement fails OPEN: probe errors yield a partial digest with the failures named; the process
// exits 0 unless the tool itself crashes. It never mutates the stack (read-only transport).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGENTIC_DAILY_COST_BREAKER_USD,
  computeSweep,
  extractCounters,
  VENUES,
} from './loop-sweep-core.mjs';
import {
  dockerInspect,
  dockerLogsTail,
  dockerPs,
  hostState,
  promApi,
  promQuery,
  psql,
} from './loop-transport.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DIGESTS_DIR = join(REPO_ROOT, 'research', 'loop', 'digests');
const ALERT_RULES_PATH = join(REPO_ROOT, 'observability', 'alerts.rules.yml');
const WATERMARK_PATH = join(DIGESTS_DIR, '.watermark.json');
const ERROR_LOG_TAIL = 3000;
const PINO_WARN_LEVEL = 40; // pino level>=40 = warn/error/fatal (§ error-scan)

// The single app container this sweep reads (docker compose default `<project>-<service>-N`,
// project = crypto-bot). No lane variants — the v3 stack has exactly one app service.
const APP_CONTAINER = 'crypto-bot-app-1';

// ── the ONLY writer: refuses any path escaping research/loop/digests/ ─────────────────────────────
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

// ── prometheus /api/v1/rules parsing ─────────────────────────────────────────────────────────────
// The loop IS the alert consumer — there is no Alertmanager in this stack and none is wanted, so a
// rule that fires reaches a human ONLY if a pass reads it. Before this probe existed the sweep
// re-derived a handful of conditions in its own core and was blind to every OTHER rule in
// observability/alerts.rules.yml; on 2026-07-27 AgentClientFatalLatch fired critical at 21:16Z and
// three consecutive collector digests still reported `alarms:[]` because nothing read it.
//
// An empty firing list is meaningless on its own (§C.9 negative-read void) — it is only evidence
// when the rules it would have come from are demonstrably loaded, current, and evaluating. Hence
// /api/v1/rules (rules + live state + health + evaluation times) rather than the ALERTS series
// (state only), and hence THREE positive controls rather than a rule count:
//
//   1. NAME SET vs the committed file. Discovered by this probe's own review, 2026-07-28: the
//      running Prometheus was serving a rules file predating 2026-07-22 — 16 rules loaded against
//      20 committed — because the container mounts alerts.rules.yml read-only and reads it ONCE at
//      process start, while the deploy step recreates only `app`. The four alerts added 2026-07-27
//      to catch a silent lane (AgenticLaneSilent, ReconciliationNeverCleanSustained,
//      ReconciliationSweepFailureSustained, AgenticBudgetExhausted) had therefore never evaluated
//      once. A count check passes 16>0 happily; only a NAME check says which rules are missing.
//      Deliberately name-only, not expr-diffing: Prometheus re-renders PromQL, so comparing query
//      text would false-positive on every multi-line rule. An expr edited under an unchanged name
//      is caught by the deploy step reloading prometheus, not here — see docs/runbook.md § Deploy.
//   2. HEALTH. A rule whose query errors sits at health='err' with a frozen state='inactive'
//      forever, reading as quietly not-firing. Also covers the freshly-restarted case, where every
//      rule is health='unknown' until its group's first evaluation.
//   3. EVALUATION FRESHNESS. A group that has stopped evaluating serves its last state indefinitely.
//
// Every one of them fails the probe (measurement fails OPEN — a named annotation, never an alarm,
// never a silent pass).
export const RULE_EVAL_STALE_FACTOR = 3;

export function parsePromRules(res, { expectedAlertNames = null, nowMs = null } = {}) {
  if (!res.ok) return { ok: false, error: res.error };
  let body;
  try {
    body = JSON.parse(res.value);
  } catch (err) {
    return { ok: false, error: `rules api: unparseable JSON (${String(err)})` };
  }
  if (!body || body.status !== 'success' || !body.data || !Array.isArray(body.data.groups)) {
    return { ok: false, error: `rules api: unexpected envelope (status=${body && body.status})` };
  }
  let ruleCount = 0;
  let alertingCount = 0;
  const loadedNames = new Set();
  const unhealthy = [];
  const staleGroups = [];
  const firing = [];
  for (const group of body.data.groups) {
    const intervalMs = Number(group && group.interval) * 1000;
    const lastEvalMs = Date.parse((group && group.lastEvaluation) || '');
    if (
      Number.isFinite(nowMs) &&
      Number.isFinite(intervalMs) &&
      intervalMs > 0 &&
      Number.isFinite(lastEvalMs) &&
      nowMs - lastEvalMs > RULE_EVAL_STALE_FACTOR * intervalMs
    ) {
      staleGroups.push(
        `${group.name} (last evaluated ${Math.round((nowMs - lastEvalMs) / 1000)}s ago, interval ${group.interval}s)`,
      );
    }
    for (const rule of (group && group.rules) || []) {
      ruleCount += 1;
      if (rule.type !== 'alerting') continue;
      alertingCount += 1;
      loadedNames.add(rule.name);
      if (rule.health !== 'ok') {
        unhealthy.push(
          `${rule.name} (health=${rule.health}${rule.lastError ? ': ' + rule.lastError : ''})`,
        );
      }
      if (rule.state !== 'firing') continue;
      // One entry per firing INSTANCE (a rule can fire for several label sets at once), falling back
      // to the rule itself when the instance list is empty so a firing rule can never read as silent.
      const instances = Array.isArray(rule.alerts)
        ? rule.alerts.filter((a) => a && a.state === 'firing')
        : [];
      const rows = instances.length > 0 ? instances : [{ labels: rule.labels, activeAt: null }];
      for (const inst of rows) {
        const labels = inst.labels || {};
        // The instance's DISTINGUISHING labels (everything past alertname/severity) — without them two
        // firing instances of the same venue-labeled rule render as byte-identical alarms, so a pass
        // reading `ReconciliationHalt` twice cannot tell whether one venue or both are halted. Several
        // rules in alerts.rules.yml are per-venue or per-symbol, which is precisely when a firing
        // instance's identity is the actionable part.
        const scope = Object.entries(labels)
          .filter(([k]) => k !== 'alertname' && k !== 'severity')
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        firing.push({
          alertname: labels.alertname || rule.name,
          severity: labels.severity || (rule.labels && rule.labels.severity) || 'unknown',
          activeAt: inst.activeAt || null,
          summary: (rule.annotations && rule.annotations.summary) || '',
          scope,
        });
      }
    }
  }
  if (alertingCount === 0) {
    return {
      ok: false,
      error:
        'rules api: prometheus has ZERO alerting rules loaded — firing state unknowable, not clean',
    };
  }
  if (expectedAlertNames && expectedAlertNames.length > 0) {
    const missing = expectedAlertNames.filter((n) => !loadedNames.has(n));
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          `rules api: prometheus is serving a STALE rules file — ${missing.length} committed alert(s) never loaded ` +
          `(${missing.join(', ')}); it reads alerts.rules.yml once at process start, so recreate the prometheus container`,
      };
    }
  }
  if (unhealthy.length > 0) {
    return {
      ok: false,
      error: `rules api: ${unhealthy.length} rule(s) not healthy — their firing state is not a current read: ${unhealthy.join('; ')}`,
    };
  }
  if (staleGroups.length > 0) {
    return {
      ok: false,
      error: `rules api: ${staleGroups.length} rule group(s) have stopped evaluating — firing state is frozen, not current: ${staleGroups.join('; ')}`,
    };
  }
  return { ok: true, value: { ruleCount, alertingCount, firing } };
}

// The alert names the repo COMMITTED, as the name-set control's expectation. Parsed with a regex
// rather than a YAML dependency: this script is stdlib-only by design (it runs outside the tsconfig
// graph and outside node_modules' guarantees), and `- alert: <Name>` is a shape markdownlint-adjacent
// churn cannot plausibly break. Returns null — the control is SKIPPED, not failed — when the file
// cannot be read, because an unreadable local file says nothing about what Prometheus loaded.
export function readExpectedAlertNames(rulesPath) {
  let text;
  try {
    text = readFileSync(rulesPath, 'utf8');
  } catch {
    return null;
  }
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*alert:\s*(\S+)\s*$/);
    if (m) names.push(m[1]);
  }
  return names.length > 0 ? names : null;
}

// ── psql single-row `-Atc` parsing: pipe-delimited columns on one line ───────────────────────────
function parsePsqlRow(res) {
  if (!res.ok) return { ok: false, error: res.error };
  const line = res.value.split('\n').find((l) => l.trim().length > 0);
  if (line === undefined) return { ok: false, error: 'empty result set' };
  return { ok: true, value: line.split('|') };
}

// ── provenance + liveness probes for the one app process ─────────────────────────────────────────
function gather() {
  const probes = {};

  // Provenance FIRST (§D): container health, RestartCount, StartedAt.
  let containerHealthy = false;
  let restartCount = null;
  let startedAt = null;
  const inspect = dockerInspect(APP_CONTAINER);
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
  const bootInfo = parsePromSeries(promQuery('boot_info'));
  if (bootInfo.ok && bootInfo.value.length > 0) {
    bootId = bootInfo.value[0].labels.boot_id || null;
  }

  // agent_decisions liveness (count + latest created_at as epoch ms) — account-level: the one
  // decision loop drives both venues (agent_decide_total carried "one lane", v3 spec §8).
  probes.decides = (() => {
    const row = parsePsqlRow(
      psql(
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

  // consult-gate total + by-outcome breakdown (Prometheus, log-independent backstop). Account-level
  // (agentic_consult_gate_total carries no venue label — v3 spec §8).
  const gateSeries = parsePromSeries(promQuery('sum by (outcome) (agentic_consult_gate_total)'));
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
    const row = parsePsqlRow(psql('select count(*) from fills', { cwd: REPO_ROOT }));
    if (!row.ok) return row;
    const count = Number(row.value[0]);
    return Number.isFinite(count)
      ? { ok: true, value: { count } }
      : { ok: false, error: `unparseable fills count: ${row.value[0]}` };
  })();

  // reconciliations: per-venue row count + latest verdict (CLEAN/MISMATCH/HALT) for the reconcile-halt
  // + journal-silence checks. The reconciliations table is venue-scoped (venue NOT NULL, one row per
  // venue-pass per tick — trading.schema.ts) even on the single stack, so this stays split by venue
  // via the same DB rather than collapsing to a global "latest row" (which would let one venue's
  // fresh CLEAN pass mask the other venue's HALT).
  probes.reconcile = {};
  for (const venue of VENUES) {
    const row = parsePsqlRow(
      psql(
        `select count(*), coalesce((select result from reconciliations where venue = '${venue}' order by id desc limit 1),'NONE') from reconciliations where venue = '${venue}'`,
        { cwd: REPO_ROOT },
      ),
    );
    probes.reconcile[venue] = !row.ok
      ? row
      : (() => {
          const count = Number(row.value[0]);
          return Number.isFinite(count)
            ? { ok: true, value: { count, latestResult: row.value[1] } }
            : { ok: false, error: `unparseable reconcile count (${venue}): ${row.value[0]}` };
        })();
  }

  // The clean STAMP, which is a different question from the rows above: this gauge is
  // ReconciliationService's `lastCleanAt` (set only on an actionable-clean, unhalted pass) and it is
  // the precondition RecoveryCoordinatorService reads before auto-resuming the kill switch. The
  // per-venue `result` column cannot answer it — that column is written off the RAW mismatch total,
  // so benign shared-wallet noise reads MISMATCH while the stamp refreshes fine (2026-07-27). Read
  // absolutely, never as a rate: 0 is the uninitialised-at-boot default, and the core ages that off
  // the container's StartedAt.
  probes.reconcileCleanStamp = (() => {
    const s = promScalar(promQuery('reconciliation_last_success_timestamp_seconds'));
    return s.ok ? { ok: true, value: { seconds: s.value } } : s;
  })();

  // kill-switch STATE (metric, never /health — §C.1: /health/ready hardcoded RUNNING once). One
  // switch for the whole book (v3 spec §8: kill_switch_state carried, no venue label).
  probes.killSwitch = (() => {
    const s = parsePromSeries(promQuery('kill_switch_state == 1'));
    if (!s.ok) return s;
    const active = s.value.find((x) => x.value === 1);
    return active
      ? { ok: true, value: { state: active.labels.state || 'unknown' } }
      : { ok: false, error: 'no kill_switch_state series == 1 (state indeterminate)' };
  })();

  // ws forced reconnects (recreation proxy) + RSS trend, both via Prometheus. wsRecreations sums
  // across venues — market_stream_forced_reconnects_total now carries a `venue` label (v3 §8) but no
  // alarm here is keyed to a specific venue, so the account-level total preserves the prior
  // "total recreations since watermark" semantics without adding per-venue alarm surface for a
  // counter that has none. rss is genuinely single-process now (one process serves both venues).
  probes.wsRecreations = (() => {
    const v = promScalar(promQuery('sum(market_stream_forced_reconnects_total)'));
    return v.ok ? { ok: true, value: { count: v.value } } : v;
  })();
  probes.rss = (() => {
    const v = promScalar(promQuery('process_resident_memory_bytes'));
    return v.ok ? { ok: true, value: { bytes: v.value } } : v;
  })();

  // Cost vs breaker: primary signal is the app's own agentic_budget_remaining_usd gauge (spend =
  // cap − remaining), which needs NO offline pricing — the three-ledger discipline (§C.7) prefers the
  // app's priced ledger over re-deriving tokens×rates here. ONE unified budget (v3 §8) — the v2
  // per-lane $1.50+$1.50 breakers are retired. The DB-token cross-check ships verified:false
  // (token→USD needs the env-configured AGENTIC_TOKEN_PRICE_* rates + the live model mix, neither
  // knowable from this pass), so it annotates rather than drives the alarm.
  probes.cost = (() => {
    const remaining = promScalar(promQuery('agentic_budget_remaining_usd'));
    if (!remaining.ok) return remaining;
    const spendUsd = Math.max(0, AGENTIC_DAILY_COST_BREAKER_USD - remaining.value);
    return { ok: true, value: { spendUsd, remainingUsd: remaining.value, verified: true } };
  })();

  // Every Prometheus alerting rule's live state, in one read (see parsePromRules' header for why
  // this is the authoritative source and not the ALERTS series). This is the ONLY probe whose scope
  // is the whole rules file rather than one metric, so it is the sweep's backstop against a
  // condition the core never learned to check for itself.
  probes.promAlerts = parsePromRules(promApi('/api/v1/rules'), {
    expectedAlertNames: readExpectedAlertNames(ALERT_RULES_PATH),
    nowMs: Date.now(),
  });

  // Error/warn scan: tail (never --since), pino level>=40, top-5 distinct msg prefixes.
  const errorScan = scanErrors(APP_CONTAINER);

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

// The next watermark: bootId + RestartCount + scalar counters for the app, plus the sweep timestamp.
function buildWatermark(sweptAtMs, app) {
  return {
    sweptAtMs,
    app: app
      ? { bootId: app.bootId, restartCount: app.restartCount, counters: extractCounters(app) }
      : null,
  };
}

function renderMarkdown({ sweptIso, host, git, app, result }) {
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
  for (const a of alarms) {
    const scope = a.venue ? ` [${a.venue}]` : '';
    L.push(`- **${a.kind}**${scope} — ${a.detail}`);
  }
  L.push('');

  L.push(`## Annotations (${result.annotations.length})`);
  if (result.annotations.length === 0) L.push('- none');
  for (const n of result.annotations) {
    const scope = n.venue
      ? `[${n.venue}${n.probe ? '.' + n.probe : ''}] `
      : n.probe
        ? `[${n.probe}] `
        : '';
    L.push(`- _${n.kind}_ ${scope}— ${n.detail}`);
  }
  L.push('');

  if (app) {
    L.push('## App');
    L.push(`- container healthy: ${app.containerHealthy}`);
    L.push(`- bootId: ${app.bootId ?? 'UNRESOLVED'}`);
    L.push(`- RestartCount: ${app.restartCount ?? 'n/a'} · StartedAt: ${app.startedAt ?? 'n/a'}`);
    L.push(`- cost breaker: $${AGENTIC_DAILY_COST_BREAKER_USD}/day`);
    const pa = app.probes && app.probes.promAlerts;
    L.push(
      `- prometheus rules: ${
        pa && pa.ok
          ? `${pa.value.ruleCount} loaded, ${pa.value.firing.length} firing`
          : `probe_failed — ${(pa && pa.error) || 'no result'}`
      }`,
    );
    L.push(
      `- deltas vs watermark: ${result.deltas ? JSON.stringify(result.deltas) : 'reset (boot changed or first sweep)'}`,
    );
    if (app.consultByOutcome) {
      L.push(`- consult-gate by outcome: ${JSON.stringify(app.consultByOutcome)}`);
    }
    const es = app.errorScan;
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

  // The single app container may still be absent (stack down, or gathered mid-restart).
  const ps = dockerPs();
  const running = ps.ok ? ps.value : '';
  const appRunning = running.includes(APP_CONTAINER);
  const app = appRunning ? gather() : null;

  const prev = loadWatermark();
  const cur = { sweptAtMs, app };
  const result = computeSweep({ prev, cur });

  if (!app) {
    result.annotations.push({
      kind: 'no_app',
      detail: ps.ok
        ? `app container not running (${APP_CONTAINER} absent)`
        : `docker ps failed: ${ps.error}`,
    });
  }

  const digest = { sweptIso, sweptAtMs, git, host, app, result };

  const safeIso = sweptIso.replace(/[:.]/g, '-');
  const digestPath = writeUnderDigests(`sweep-${safeIso}.json`, JSON.stringify(digest, null, 2));
  writeUnderDigests('.watermark.json', JSON.stringify(buildWatermark(sweptAtMs, app), null, 2));

  const markdown = renderMarkdown({ sweptIso, host, git, app, result });
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
