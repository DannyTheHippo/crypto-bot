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
//      created_at (raw row count — includes scheduled-skip rows with no model call), a SEPARATE
//      genuine-model-decide count on the same table filtered to a completed round trip (see
//      `probes.realDecides`), fills, per-venue reconciliations tail, kill-switch state, ws
//      forced-reconnects, RSS, and the LLM cost-vs-breaker proximity. Every stack read goes through
//      loop-transport.mjs (one GCP-lift seam) and returns {ok,value}|{ok,error} — a failed probe is
//      reported, never thrown.
//   4. Hands {prev watermark, cur probes} to the PURE core (loop-sweep-core.mjs), which derives the
//      bootId-pinned deltas, the fired alarms, and the annotations — deltas only when bootId matches.
//   5. Writes the digest JSON + updates the watermark UNDER research/loop/digests/ ONLY (single writer
//      helper), and renders the markdown digest to stdout.
//
// Measurement fails OPEN: probe errors yield a partial digest with the failures named; the process
// exits 0 unless the tool itself crashes. It never mutates the stack (read-only transport).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGENTIC_DAILY_COST_BREAKER_USD,
  ALERT_LOOKBACK_MS,
  classifyUnrecordedSweeps,
  computeSweep,
  extractCounters,
  isBuildProvenanceVoid,
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
const PASS_LOG_PATH = join(REPO_ROOT, 'research', 'loop', 'LOG.md');
// Raised 3000 -> 20000 on 2026-07-28. The tail is a LINE bound but the pass reasons in TIME, and at
// this stack's log rate (~1.6k lines/h) 3000 lines covered under 2h — so a 49-minute venue outage
// that ended 6h before the pass ran produced 340 warn lines the sweep never saw. 20k lines is ~12h
// here, matching ALERT_LOOKBACK_MS; the core discloses the span actually achieved (log_window_short)
// rather than trusting this number, because the log rate is not ours to fix.
export const ERROR_LOG_TAIL = 20000;
const PINO_WARN_LEVEL = 40; // pino level>=40 = warn/error/fatal (§ error-scan)

// observability/prometheus.yml's global.scrape_interval, in seconds. Used ONLY to derive the expected
// sample count for the alert-window coverage control — a drift between the two shows up as an apparent
// coverage shortfall, which annotates (fails toward disclosure) rather than passing silently.
const PROM_SCRAPE_INTERVAL_S = 15;

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

// Pass 48 (2026-07-30): reads agent_client_latch_cause — a closed three-member set seeded at 0 for
// every boot (Pass 47/48 zero-seed convention, metrics.service.ts/agent-metrics-recorder.service.ts)
// — and returns which single child, if any, currently reads 1. Follows promScalar's own
// not-a-zero contract rather than parsePromSeries': an EMPTY vector means the gauge was never
// registered (a binary predating this metric, or the metric renamed/dropped) and is a probe
// FAILURE, never a quiet "not latched" — the exact distinction promScalar already draws for a plain
// scalar gauge, extended here to a labeled closed set.
export function promActiveCause(res) {
  const parsed = parsePromSeries(res);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value.length === 0) {
    return {
      ok: false,
      error: 'empty instant vector (no series) — agent_client_latch_cause was never seeded',
    };
  }
  const active = parsed.value.find((s) => s.value === 1);
  return { ok: true, value: { cause: active ? (active.labels.cause ?? null) : null } };
}

// Pass 50 (2026-07-30): agentic_consult_gate_total by outcome. Before this fix the probe summed
// `sum by (outcome) (agentic_consult_gate_total)` with a plain reduce over whatever series came
// back — an EMPTY instant vector (metric never registered: an old binary, or a renamed/dropped
// metric) summed to `total: 0` and reported `ok: true`, indistinguishable from a genuinely quiet
// consult-gate window. Every sibling scalar probe (promScalar) and the labeled agent_client_
// latch_cause probe (promActiveCause above) already refuse an empty vector as a probe FAILURE, never
// a quiet zero — this brings agentic_consult_gate_total into the same not-a-zero contract. The Pass
// 50 constructor zero-seed (agent-metrics-recorder.service.ts) means a real boot never returns an
// empty vector here either, so this is a defense against the same predating-binary/renamed-metric
// case promActiveCause's own comment names, not a case this sweep expects to hit routinely.
export function promConsultGateTotal(res) {
  const parsed = parsePromSeries(res);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value.length === 0) {
    return {
      ok: false,
      error: 'empty instant vector (no series) — agentic_consult_gate_total was never seeded',
    };
  }
  let total = 0;
  const byOutcome = {};
  for (const s of parsed.value) {
    total += s.value;
    if (s.labels.outcome) byOutcome[s.labels.outcome] = s.value;
  }
  return { ok: true, value: { total, byOutcome } };
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

// ── prometheus ALERTS history: what fired while nobody was looking ───────────────────────────────
// Companion to parsePromRules above, reading the same rules file BACKWARDS. Prometheus keeps the
// synthetic ALERTS series in its own TSDB, so "did anything fire since the last pass" costs one
// instant query and no new infrastructure. Why it is needed at all, and why it annotates rather than
// alarms, is argued where it is consumed (loop-sweep-core.mjs, § alertsSince).
//
// Rows of `count_over_time(ALERTS{alertstate="firing"}[Ns])`, reduced to one entry per alert NAME.
// Name-keyed, not label-set-keyed, deliberately: the same alert can appear both with and without
// instance/job labels across one window, because a rule whose expr aggregates (`sum(...)` — e.g.
// ReconcilerStalled and AgenticLaneSilent in observability/alerts.rules.yml)
// drops the target labels its siblings keep. Treating those as distinct entries would report a
// still-firing alert as "resolved" — the one error this probe must not make. The cost of collapsing is
// that a per-venue rule which resolved on one venue while still firing on the other is not reported
// here; that is under-reporting confined to alert names the pass is ALREADY seeing live above, so it
// can never introduce a blind spot, only decline to add detail.
// The subtraction list, extracted so it is testable. Inline in gather() this was the single most
// load-bearing untested line in the probe: swapping `.alertname` for `.scope`, or dropping the map,
// leaves every unit test green while re-introducing the false "resolved" the whole design prevents.
// A failed/absent live probe yields NO names — the core refuses to interpret the window in that case
// rather than this function guessing a safe default.
export function firingAlertNames(promAlertsProbe) {
  if (!promAlertsProbe || promAlertsProbe.ok !== true || !promAlertsProbe.value) return [];
  return (promAlertsProbe.value.firing || []).map((a) => a.alertname).filter(Boolean);
}

export function parseAlertsFiredWithin(res, { currentlyFiringNames = [] } = {}) {
  const parsed = parsePromSeries(res);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const live = new Set(currentlyFiringNames);
  const byName = new Map();
  for (const s of parsed.value) {
    const alertname = s.labels.alertname;
    if (!alertname || live.has(alertname)) continue;
    const severity = s.labels.severity || 'unknown';
    const samples = Number.isFinite(s.value) ? s.value : 0;
    const prev = byName.get(alertname);
    if (!prev) {
      byName.set(alertname, { alertname, severity, samples });
      continue;
    }
    // Critical wins, and the longest-running label set sets the sample count: a name that fired critical
    // on any label set is reported critical, never softened by a warning-severity sibling. Only
    // `critical` promotes — the remaining severities carry no order worth encoding, and all 20 committed
    // rules declare one, so the first-seen value stands for them.
    if (severity === 'critical') prev.severity = 'critical';
    prev.samples = Math.max(prev.samples, samples);
  }
  return { ok: true, value: { resolved: [...byName.values()], lookbackMs: ALERT_LOOKBACK_MS } };
}

// ── bootId provenance, with ambiguity refused rather than resolved by array order ────────────────
// Extracted and exported because it is a provenance GUARD, and an untested guard is a guard that
// silently stops guarding. See its call site in gather() for the incident that motivated it.
export function resolveBootId(bootInfoSeries) {
  if (!bootInfoSeries.ok) return { bootId: null, error: null };
  const ids = [...new Set(bootInfoSeries.value.map((s) => s.labels.boot_id).filter(Boolean))];
  if (ids.length === 1) return { bootId: ids[0], error: null };
  if (ids.length === 0) return { bootId: null, error: null };
  return {
    bootId: null,
    error:
      `boot_info served ${ids.length} boot ids at once (${ids.join(', ')}) — a redeploy is ` +
      'mid-flight and provenance is unresolvable this sweep, so deltas are suppressed rather than ' +
      'computed against whichever id was printed first',
  };
}

// ── build provenance, with the same ambiguity refused for the same reason ────────────────────────
// `build_info` is set beside `boot_info` in one onModuleInit and scraped by one target, so it
// inherits the identical post-redeploy window: two series under one instance until the outgoing
// sample ages out of the instant lookback. Taking [0] there reads the OUTGOING image's sha — and a
// deploy is precisely when the sha changes, so that is the one sweep whose provenance matters most
// (the playbook runs a sweep inside that window, §5 step 4). Refused rather than resolved by print
// order; it lands as probe_failed[build], the same fail-open direction a missing probe takes.
//
// A missing label stays DISTINCT from a present-but-empty one: both are void, but the dedupe must
// not drop falsy members the way resolveBootId's `.filter(Boolean)` does, or "no label at all"
// silently becomes "one series with a label".
export function resolveBuildSha(buildInfoSeries) {
  if (!buildInfoSeries.ok) return buildInfoSeries;
  if (buildInfoSeries.value.length === 0)
    return { ok: false, error: 'empty instant vector (no build_info series)' };
  const shas = [...new Set(buildInfoSeries.value.map((s) => s.labels.git_sha))];
  if (shas.length > 1) {
    const rendered = shas.map((s) => (s === undefined ? '<no label>' : `"${s}"`)).join(', ');
    return {
      ok: false,
      error:
        `build_info served ${shas.length} git shas at once (${rendered}) — a redeploy is mid-flight ` +
        'and provenance is unresolvable this sweep, so no build is named rather than whichever one ' +
        'promtool printed first',
    };
  }
  // Verbatim, including the literal 'unknown' and an absent label (null). The old `|| 'unknown'`
  // fallback collapsed "no label" and "built without the arg" into a string the digest then printed
  // as a value; the core classifies instead (isBuildProvenanceVoid).
  return { ok: true, value: { gitSha: shas[0] === undefined ? null : shas[0] } };
}

// The digest cell for that probe, exported for the same reason the resolver is: an untested render is
// how a non-reading gets printed as a reading again. One predicate decides here and in the core
// (isBuildProvenanceVoid), so the line and the annotation can never disagree.
export function formatRunningBuild(buildProbe) {
  if (!buildProbe || buildProbe.ok !== true)
    return `probe_failed — ${(buildProbe && buildProbe.error) || 'no result'}`;
  const sha = buildProbe.value ? buildProbe.value.gitSha : null;
  if (!isBuildProvenanceVoid(sha)) return sha;
  const found = sha === null || sha === undefined ? 'no git_sha label' : `git_sha="${sha}"`;
  return `VOID (${found}) — image built without GIT_SHA, provenance unrecorded`;
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
  // do not).
  //
  // AMBIGUITY IS REFUSED, never resolved by array order. For a few minutes after every redeploy
  // Prometheus can still serve the PREVIOUS boot's series alongside the new one (the old child is
  // gone from the exposition but its last sample is inside the instant-query lookback until a
  // staleness marker lands), so `boot_info` legitimately returns two series with one `instance`.
  // Taking [0] then picks by whatever order promtool printed — and picking the stale one is not a
  // cosmetic error: the core computes deltas ONLY when bootId matches the watermark, so reading the
  // old id makes a cross-boot delta pass that guard and fabricate a window that never existed.
  // Observed live 2026-07-29: two sweeps 90s apart, unchanged StartedAt, different bootIds, and the
  // first reported decides:120 across a boot boundary.
  //
  // Fails toward disclosure: an unresolved bootId becomes probe_failed[bootId] in the core, which
  // suppresses deltas rather than guessing — the same direction a missing probe already takes.
  const boot = resolveBootId(parsePromSeries(promQuery('boot_info')));
  const bootId = boot.bootId;
  if (boot.error) {
    probes.bootInfo = { ok: false, error: boot.error };
  }

  // agent_decisions liveness (count + latest created_at as epoch ms) — account-level: the one
  // decision loop drives both venues (agent_decide_total carried "one lane", v3 spec §8).
  //
  // THIS IS AN UNFILTERED ROW COUNT. agent_decisions gets a row per symbol per scheduled skip where
  // no model call happens at all — verified live 2026-07-29: 160 rows/hour, every hour, for 12
  // straight hours while both LLM provider accounts sat unfunded (Anthropic 400 "credit balance too
  // low", Moonshot 429 suspended) and the lane made ZERO real model calls. Same defect class as Pass
  // 44 (a never-incremented labeled counter reads identical to a nonexistent one) and Pass 46 (a
  // NOT-NULL column whose only writer supplies a literal reads identical to a measurement): a
  // liveness counter that counts non-events is indistinguishable from a live lane. Kept anyway — it
  // is not useless, only mislabelled: if the SCHEDULER itself stalls this row count DOES freeze, so it
  // still detects the 8.2h candle-stall class. `probes.realDecides` below is the separate instrument
  // for "did the model actually answer".
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

  // GENUINE model-decide liveness — the counter `decides` above cannot be, by construction (a
  // scheduled-skip row and a real decide are the same table, same shape, no separate flag). Same
  // structural predicate PromotionStatsRepository.lastSuccessfulDecideAt uses to seed
  // agent_last_success_timestamp_seconds (WATCH-V4-8), copied verbatim rather than re-derived so the
  // two instruments can never disagree — a .mjs script cannot import the TS constant, so the tag list
  // below is a hand-mirror of DEGRADED_DECIDE_RATIONALE_TAGS (domain/strategy/types) and must be
  // edited with it. prompt_hash and latency_ms are set TOGETHER, and only by code that has already
  // received and parsed an HTTP response body (MetricsWrappingAgentClient); the degrade tags are then
  // subtracted because a post-200 degrade carries both too, and "the model answered with something
  // unusable" is not liveness. The replay-<runId> exclusion matches tokenTotals' BY-FILTER exclusion
  // in the same repository — an R1 backfill writes agent_decisions rows carrying both fields, and a
  // backfill must never make a dead lane read fresh. Verified live 2026-07-29: 0 rows in the last 12h,
  // 575 of 22,873 lifetime (660 before the degrade subtraction, 85 of them schema_rejected holds),
  // newest 2026-07-27T20:15:31Z (38.3h stale) — matching lastSuccessfulDecideAt's own comment exactly.
  probes.realDecides = (() => {
    const row = parsePsqlRow(
      psql(
        "select count(*), coalesce((extract(epoch from max(created_at))*1000)::bigint,0) from agent_decisions where prompt_hash <> '' and latency_ms is not null and strategy_id not like 'replay-%'" +
          " and not starts_with(rationale, 'schema_rejected:')" +
          " and not starts_with(rationale, 'envelope_malformed:')" +
          " and not starts_with(rationale, 'model_refusal:')" +
          " and not starts_with(rationale, 'truncated_max_tokens:')" +
          " and not starts_with(rationale, 'no_tool_use:')" +
          " and not starts_with(rationale, 'capability_violation:')",
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
  // (agentic_consult_gate_total carries no venue label — v3 spec §8). promConsultGateTotal (above)
  // owns the empty-vector-is-a-failure contract — see its own comment.
  const gateResult = promConsultGateTotal(
    promQuery('sum by (outcome) (agentic_consult_gate_total)'),
  );
  const consultByOutcome = gateResult.ok ? gateResult.value.byOutcome : null;
  probes.consultGate = gateResult.ok
    ? { ok: true, value: { total: gateResult.value.total } }
    : gateResult;

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

  // Pass 48: which closed-set cause (if any) is behind the current agent_client_latched — the
  // whole point being that this pass never has to re-investigate the known, owner-blocked
  // unfunded-account condition (see the '## LLM PROVIDER ACCOUNT UNFUNDED' banner in
  // renderMarkdown below). MANDATORY like realDecides/promAlerts/build further down: the generic
  // probe-failure loop in loop-sweep-core.mjs only visits keys that EXIST, so an absent probe would
  // read as "cause unknown, no banner" rather than the classifier crash it actually was.
  //
  // Pass 48 review: an instant read of agent_client_latched itself measured avg_over_time = 0.836
  // over 24h (943/5759 scrapes at 0) — a no-op decide (a proposal with no ref price returns early
  // with no HTTP call, yet is tagged outcome="hold") clears the level and cause on the very next
  // scrape after a latch, so an instant read of the cause misses the banner ~1 in 6 sweeps for a
  // condition that never actually cleared. max_over_time(...[6h]) reads whichever cause held 1 at
  // ANY scrape in the window, so a real-but-momentarily-cleared latch still shows its cause. Cost:
  // the banner can persist up to 6h after credit actually lands — accepted, since a false "still
  // unfunded" banner just wastes one glance, while a missed one sends a pass to re-investigate.
  probes.latchCause = promActiveCause(promQuery('max_over_time(agent_client_latch_cause[6h])'));

  // Every Prometheus alerting rule's live state, in one read (see parsePromRules' header for why
  // this is the authoritative source and not the ALERTS series). This is the ONLY probe whose scope
  // is the whole rules file rather than one metric, so it is the sweep's backstop against a
  // condition the core never learned to check for itself.
  // The same question asked of the recent past, and of the present. ORDER MATTERS, in the direction
  // that makes the race safe: the history is CAPTURED first and the live rule state read second.
  //
  // These are two separate `docker exec` round-trips seconds apart. Reading live-first means an alert
  // that begins firing between them is missing from the subtraction list but present in the window, so
  // the sweep would announce a live alert as "fired and RESOLVED … nothing above will show it" — the one
  // error this probe must never make. Capturing history first inverts it: a newly-firing alert lands in
  // both reads and is subtracted, and the residual error becomes silently under-reporting an alert that
  // resolved in the gap. Under-reporting a just-resolved alert is recoverable on the next sweep;
  // contradicting the alarm list is not.
  const alertsSinceRaw = promQuery(
    `count_over_time(ALERTS{alertstate="firing"}[${Math.round(ALERT_LOOKBACK_MS / 1000)}s])`,
  );

  // Retrospective positive control for the window above (the core argues why the live rules probe is
  // necessary but not sufficient). `up` is written on every scrape whether the target is healthy or not,
  // so its sample count over the window measures PROMETHEUS' own coverage — the thing that decides
  // whether "no alerts fired" is a fact or a hole. Expected = window / scrape_interval, re-verified
  // against observability/prometheus.yml (global.scrape_interval: 15s) — a config change there without
  // one here shows up as a coverage shortfall, which fails toward disclosure, not toward silence.
  probes.promCoverage = (() => {
    const windowS = Math.round(ALERT_LOOKBACK_MS / 1000);
    const samples = promScalar(promQuery(`count_over_time(up{job="crypto-bot"}[${windowS}s])`));
    if (!samples.ok) return samples;
    const expected = Math.round(windowS / PROM_SCRAPE_INTERVAL_S);
    return {
      ok: true,
      value: {
        samples: samples.value,
        expected,
        ratio: expected > 0 ? samples.value / expected : 0,
      },
    };
  })();

  probes.promAlerts = parsePromRules(promApi('/api/v1/rules'), {
    expectedAlertNames: readExpectedAlertNames(ALERT_RULES_PATH),
    nowMs: Date.now(),
  });

  // ── the in-app replacements for what the retired collector daemon scraped from outside ──────────
  const windowS = Math.round(ALERT_LOOKBACK_MS / 1000);

  // app_log_events_total is the DURABLE half of the error scan. The `docker logs` tail below is still
  // read, but only for narrative — its window is whatever the log rate makes it and a container
  // recreate erases it outright, whereas this survives in the TSDB for the retention horizon and
  // covers exactly the window the pass reasons over.
  //
  // TWO readings, because neither alone is honest here:
  //   window — increase() over the lookback. Correct across process restarts (it sums pre- and
  //     post-reset), but it UNDERCOUNTS a label child born inside the window: prom-client creates a
  //     child lazily at its first increment, so a message class that fired once has an identical
  //     first and last sample and increase() reads 0. Same first-sample trap alerts.rules.yml
  //     documents for AgenticLaneSilent.
  //   boot — the raw cumulative. Exact for everything since the current process started, immune to
  //     the newborn-child problem, and blind to anything before the last restart.
  // Together they bracket the truth: `boot` is the exact floor for this boot, `window` reaches back
  // across restarts. Reported side by side rather than reconciled, because collapsing them would
  // require guessing which failure mode applied.
  probes.logEvents = (() => {
    const sumByLevel = (expr) => {
      const res = parsePromSeries(promQuery(expr));
      if (!res.ok) return null;
      const out = {};
      for (const s of res.value) {
        if (s.labels.level) out[s.labels.level] = s.value;
      }
      return out;
    };
    const byLevelWindow = sumByLevel(
      `sum by (level) (increase(app_log_events_total[${windowS}s]))`,
    );
    if (byLevelWindow === null) {
      return { ok: false, error: 'app_log_events_total window query returned no parseable series' };
    }
    const byLevelBoot = sumByLevel('sum by (level) (app_log_events_total)') || {};
    // `none` is the zero-materialising child (log-event-metrics.ts), never a real event — excluded so
    // the top list carries only things that actually happened. Ranked on the since-boot value, the
    // exact one.
    const topRes = parsePromSeries(
      promQuery(`topk(5, sum by (level, event) (app_log_events_total{event!="none"}))`),
    );
    const top = topRes.ok
      ? topRes.value
          .filter((s) => s.value > 0)
          .map((s) => ({
            level: s.labels.level || 'unknown',
            event: s.labels.event || '?',
            count: s.value,
          }))
          .sort((a, b) => b.count - a.count)
      : [];
    return { ok: true, value: { byLevelWindow, byLevelBoot, top, windowMs: ALERT_LOOKBACK_MS } };
  })();

  // Host duty cycle, measured from INSIDE the suspended process rather than from `pmset`/`uptime` on
  // the host. The gauge is per-tick, so the window's max is the largest single freeze in it.
  probes.suspends = (() => {
    const count = promScalar(promQuery(`increase(app_suspend_events_total[${windowS}s])`));
    if (!count.ok) return count;
    const maxSkew = promScalar(
      promQuery(`max_over_time(app_wall_clock_skew_seconds[${windowS}s])`),
    );
    return {
      ok: true,
      value: {
        count: count.value,
        maxSkewSeconds: maxSkew.ok ? maxSkew.value : null,
        windowMs: ALERT_LOOKBACK_MS,
      },
    };
  })();

  // Which build is actually serving — the deploy-provenance fact the collector used to stamp on every
  // hourly digest line from the working tree. Read from the RUNNING process, which is the version that
  // matters; the working-tree tip is recorded separately and the two legitimately differ mid-pass.
  probes.build = resolveBuildSha(parsePromSeries(promQuery('build_info')));

  // Parsed only now, once the live names exist to subtract. When promAlerts failed there are no names,
  // so everything in the window would read as resolved — the core voids the whole probe in that case
  // rather than trusting a subtraction against an empty set.
  probes.promAlertsSince = parseAlertsFiredWithin(alertsSinceRaw, {
    currentlyFiringNames: firingAlertNames(probes.promAlerts),
  });

  // Error/warn scan: tail (never --since), pino level>=40, named categories + top-5 distinct prefixes.
  // Assigned INTO probes (adversarial review, 2026-07-30), not returned as a sibling field: the core's
  // generic probe-failure loop iterates Object.entries(probes) only, so a sibling errorScan was
  // invisible to it — a docker-logs-tail failure (or the warn-breakdown consistency check above)
  // produced NO annotation of any kind, a silent failure on the one probe whose own log_window_short/
  // log_window_unknown disclosures exist specifically to stop a warn count being misread as clean.
  probes.errorScan = scanErrors(APP_CONTAINER);

  return {
    bootId,
    containerHealthy,
    restartCount,
    startedAt,
    probes,
    consultByOutcome,
  };
}

// pino level>=40 lines from a bounded tail; rank the 5 most common message prefixes so the digest
// carries signal, not a raw log wall.
function scanErrors(container) {
  const res = dockerLogsTail(container, ERROR_LOG_TAIL);
  if (!res.ok) return { ok: false, error: res.error };
  const value = scanPinoLines(res.value);
  // Fails OPEN like every other probe in this file (never crashes the whole sweep over one broken
  // breakdown), but LOUD: an internal-consistency failure becomes a named probe_failed annotation —
  // never a silently under-reported `other` — see the assertion's own comment below for the incident
  // this closes.
  if (value.consistencyError) return { ok: false, error: value.consistencyError };
  return { ok: true, value };
}

// Pass 50 (2026-07-30): named message-FAMILY categories, matched by substring test on the raw message
// rather than the 48-char raw-prefix map below. A raw prefix fragments a single incident class into
// many buckets whenever the incident's own identifier (symbol, channel, venue) sits at the START of
// the message — market-stream's `${symbol}|${channel}` sits right after the fixed "market-stream "
// lead-in (ccxt-stream.adapter.ts's handleLoopError), so a single network incident touching several
// symbol/channel pairs produces several distinctly-prefixed buckets, each individually too small to
// crack the top-5 raw-prefix list even though the incident as a whole is not small — invisible in the
// digest, and burying it made the warn count useless for diagnosis. `feed poll failed ... request
// timed out` (derivatives/sentiment/positioning/trade-flow/fear-greed feed services) fragments the
// same way, one bucket per feed's own marketId/symbol.
const NAMED_WARN_CATEGORIES = [
  {
    name: 'market-stream loop error (resubscribing)',
    test: (msg) => msg.includes('market-stream ') && msg.includes('loop error (resubscribing)'),
  },
  {
    name: 'feed poll failed (request timed out)',
    test: (msg) =>
      msg.includes('feed poll failed') && msg.toLowerCase().includes('request timed out'),
  },
];

// The pure half of scanErrors, split out so the span rule below is testable without docker.
export function scanPinoLines(text) {
  const prefixCounts = new Map();
  const namedCounts = new Map(NAMED_WARN_CATEGORIES.map((c) => [c.name, 0]));
  let matched = 0;
  let lines = 0;
  let oldestMs = null;
  let newestMs = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    lines += 1;
    // Span is tracked over EVERY parsed line, ABOVE the warn filter — not just warn+ ones. The question
    // it answers is "how far back does this tail reach", and a window whose only warn line is recent
    // still covers whatever its oldest line says. Taking the span from warn lines alone would report the
    // window as short exactly when it was quietly healthy, i.e. manufacture doubt about a real green.
    if (Number.isFinite(obj.time)) {
      if (oldestMs === null || obj.time < oldestMs) oldestMs = obj.time;
      if (newestMs === null || obj.time > newestMs) newestMs = obj.time;
    }
    if (!Number.isFinite(obj.level) || obj.level < PINO_WARN_LEVEL) continue;
    matched += 1;
    const msg = typeof obj.msg === 'string' ? obj.msg : '';
    // Each matched line lands in EXACTLY ONE bucket — a named category if it matches, otherwise the
    // raw-prefix map — never both, never neither. That mutual exclusivity is what makes the
    // consistency assertion below a genuine regression guard rather than decoration: a future edit
    // that breaks it (e.g. a category test that stops excluding the prefix path) trips the assertion
    // immediately instead of silently misreporting `other`.
    const category = NAMED_WARN_CATEGORIES.find((c) => c.test(msg));
    if (category) {
      namedCounts.set(category.name, namedCounts.get(category.name) + 1);
    } else {
      const prefix = msg.slice(0, 48) || '(no msg)';
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }
  const named = [...namedCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, count }));
  const top = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([prefix, count]) => ({ prefix, count }));
  const namedTotal = named.reduce((sum, n) => sum + n.count, 0);
  const unnamedTotal = [...prefixCounts.values()].reduce((sum, n) => sum + n, 0);
  // DERIVED, not independently tallied (Pass 50): `other` is defined as matched minus the named sum,
  // by construction — never a second, separately-maintained count that could disagree with `matched`.
  // scanPinoLines had no `other` field before this fix (there was nothing here to drift); the point of
  // deriving it this way is to rule the possibility out permanently, not to have fixed a prior drift.
  const other = matched - namedTotal;
  // The assertion itself: fails OPEN (scanErrors above turns this into a named probe_failed
  // annotation, never a process crash or a silently wrong digest line) but LOUD — a future regression
  // that breaks the named/prefix mutual exclusivity above (e.g. a category test that stops excluding
  // the raw-prefix path) must surface immediately rather than silently misreporting the total.
  const consistencyError =
    other === unnamedTotal
      ? null
      : `warn breakdown does not sum to its own total — matched=${matched} named=${namedTotal} ` +
        `other=${other} but the unnamed-prefix tally is ${unnamedTotal}`;
  return {
    matched,
    scanned: ERROR_LOG_TAIL,
    lines,
    oldestMs,
    newestMs,
    named,
    other,
    top,
    consistencyError,
  };
}

function loadWatermark() {
  try {
    return JSON.parse(readFileSync(WATERMARK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// The two repo-artifact reads behind the pass-record audit (see classifyUnrecordedSweeps in the
// core). Both return null on any failure rather than throwing: the core turns a null into the loud
// `pass_record_audit_undetermined` note, so a missing LOG.md or an unlistable digests dir costs this
// one check and never the sweep. Local file reads, not stack access — they stay host-local after a
// GCP lift, same as gitTip().
function readPassLog() {
  try {
    return readFileSync(PASS_LOG_PATH, 'utf8');
  } catch {
    return null;
  }
}

function listDigestNames() {
  try {
    return readdirSync(DIGESTS_DIR);
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

// Human-readable tail span. `Number.isFinite` does NOT bound a Date: a corrupt or foreign line carrying
// a finite but out-of-range `time` makes toISOString throw RangeError, which would cost the entire
// markdown render for a cosmetic field.
function describeSpan({ oldestMs, newestMs }) {
  if (!Number.isFinite(oldestMs) || !Number.isFinite(newestMs)) return 'span unknown';
  const hours = ((newestMs - oldestMs) / 3_600_000).toFixed(1);
  const oldestIso =
    Math.abs(oldestMs) <= 8.64e15 ? new Date(oldestMs).toISOString() : 'unrenderable';
  return `${hours}h back to ${oldestIso}`;
}

export function renderMarkdown({ sweptIso, host, git, app, result }) {
  const L = [];
  L.push(`# Loop health sweep — ${sweptIso}`);
  L.push('');

  // Pass 48 (2026-07-30): unmissable, BEFORE the alarms section (in fact before everything else),
  // so a pass reading the digest top-to-bottom hits this before it ever reaches the Alarms header.
  // Does NOT touch how alarms are computed (loop-sweep-core.mjs is untouched by this block) and adds
  // no new alarm kind — the alert-severity split in observability/alerts.rules.yml is what stops
  // this condition from blocking; this banner only makes the digest say it in plain language.
  const latchCause = app && app.probes && app.probes.latchCause;
  if (latchCause && latchCause.ok === true && latchCause.value?.cause === 'insufficient_credit') {
    const rd = app.probes.realDecides;
    const lastReal =
      rd &&
      rd.ok === true &&
      Number.isFinite(rd.value?.latestCreatedAtMs) &&
      rd.value.latestCreatedAtMs > 0
        ? new Date(rd.value.latestCreatedAtMs).toISOString()
        : 'never recorded';
    L.push('## LLM PROVIDER ACCOUNT UNFUNDED — KNOWN STANDING BLOCKER, NOT A DEFECT');
    L.push('');
    L.push(
      `The agentic lane's LLM provider account has no credit. Decides are suppressed. **This is not ` +
        `a defect and is not investigable by an automated pass — do NOT open a defect investigation.** ` +
        `The only fix is the owner adding credit to the account; the lane self-heals within 30 ` +
        `minutes of credit landing, with no redeploy required. Last real model decide: ${lastReal}.`,
    );
    L.push('');
  }

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
    // Unambiguous by construction: `decides` in the JSON line above is a raw agent_decisions ROW
    // count (one row per symbol per scheduled skip, no model call required) and reads as "N decisions
    // were made" to anyone who has not read this comment. Spelled out here so a reader can never
    // mistake a scheduler tick for a model round trip — the exact confusion that let 160 rows/hour
    // read as a live lane while both LLM providers sat unfunded for 12+ straight hours.
    L.push(
      `- decide rows vs REAL model decides: Δ${result.deltas ? (result.deltas.decides ?? 'n/a') : 'n/a'} total agent_decisions row(s) ` +
        '(ALL outcomes incl. scheduled-skip/error — NOT evidence of a model call) vs ' +
        `Δ${result.deltas ? (result.deltas.realDecides ?? 'n/a') : 'n/a'} REAL model decide(s) ` +
        "(prompt_hash<>'' AND latency_ms IS NOT NULL AND strategy_id NOT LIKE 'replay-%' AND no " +
        'post-200 degrade tag on the rationale — same predicate ' +
        'PromotionStatsRepository.lastSuccessfulDecideAt uses to seed ' +
        'agent_last_success_timestamp_seconds)',
    );
    const rd = app.probes && app.probes.realDecides;
    L.push(
      `- real model decides (lifetime): ${
        rd && rd.ok === true
          ? `${rd.value.count} total, newest ${
              Number.isFinite(rd.value.latestCreatedAtMs) && rd.value.latestCreatedAtMs > 0
                ? new Date(rd.value.latestCreatedAtMs).toISOString()
                : 'never recorded'
            }`
          : `probe_failed — ${(rd && rd.error) || 'no result'}`
      }`,
    );
    if (app.consultByOutcome) {
      L.push(`- consult-gate by outcome: ${JSON.stringify(app.consultByOutcome)}`);
    }
    // Mirrors the core's verdict rather than restating the raw probe: when the live rules probe failed
    // the resolved list is UNSUBTRACTED and may name alerts that are firing right now, so rendering it
    // as fact would contradict the alarm list directly above it.
    const ps = app.probes && app.probes.promAlertsSince;
    const liveOk = Boolean(
      app.probes && app.probes.promAlerts && app.probes.promAlerts.ok === true,
    );
    L.push(
      `- alerts fired+resolved in the last ${ALERT_LOOKBACK_MS / 3_600_000}h: ${
        !ps || !ps.ok
          ? `probe_failed — ${(ps && ps.error) || 'no result'}`
          : !liveOk
            ? 'VOID — live rules probe failed, nothing to subtract firing alerts against'
            : (ps.value.resolved || []).length === 0
              ? 'none'
              : ps.value.resolved
                  .map((a) => `${a.alertname} (${a.severity}, ${a.samples} samples)`)
                  .join('; ')
      }`,
    );
    // Deploy provenance from the RUNNING process. The sha is rendered rather than annotated: a pass
    // that has just committed legitimately sits ahead of the deployed image, so a DRIFT annotation
    // would fire on almost every pass and teach the reader to skip it. Stated as fact, next to the
    // tree tip it should be compared against. A VOID reading is the opposite case and the core does
    // annotate it (build_provenance_void) — an image built without GIT_SHA has no provenance to
    // state, and printing the ARG default here as if it were read is the §C.9 void this line caused.
    L.push(
      `- running build: ${formatRunningBuild(app.probes && app.probes.build)}` +
        ` (working tree ${git ?? 'n/a'})`,
    );
    const sus = app.probes && app.probes.suspends;
    if (sus && sus.ok) {
      L.push(
        `- host duty cycle: ${Math.round(sus.value.count)} suspend(s) in ${ALERT_LOOKBACK_MS / 3_600_000}h` +
          `${Number.isFinite(sus.value.maxSkewSeconds) ? `, longest ${(sus.value.maxSkewSeconds / 60).toFixed(0)}min` : ''}`,
      );
    } else {
      L.push(`- host duty cycle: probe_failed — ${(sus && sus.error) || 'no result'}`);
    }
    const le = app.probes && app.probes.logEvents;
    if (le && le.ok) {
      const fmt = (m) =>
        ['fatal', 'error', 'warn'].map((lv) => `${lv}=${Math.round((m || {})[lv] ?? 0)}`).join(' ');
      L.push(
        `- log events — ${ALERT_LOOKBACK_MS / 3_600_000}h window: ${fmt(le.value.byLevelWindow)} · ` +
          `this boot (exact): ${fmt(le.value.byLevelBoot)}`,
      );
      for (const t of le.value.top.slice(0, 5)) {
        L.push(`  - ${Math.round(t.count)}× [${t.level}] ${t.event} (this boot)`);
      }
    } else {
      L.push(`- log events: probe_failed — ${(le && le.error) || 'no result'}`);
    }
    // errorScan lives under probes (adversarial review, 2026-07-30) — see gather()'s own comment.
    const es = (app.probes && app.probes.errorScan) || { ok: false, error: 'no result' };
    if (es.ok) {
      // The span is stated next to the count because the count alone reads as a whole-window verdict
      // and is not one — see the core's log_window_short annotation.
      L.push(
        `- warn+ lines (${es.value.lines} parsed from a ${es.value.scanned}-line tail request, covers ${describeSpan(es.value)}): ${es.value.matched}` +
          ` (named ${(es.value.named || []).reduce((s, n) => s + n.count, 0)}, other ${es.value.other})`,
      );
      // Pass 50: named message-family buckets FIRST — these are the classes worth an operator's eye
      // (see NAMED_WARN_CATEGORIES' own comment for why raw-prefix ranking alone buried them).
      for (const n of es.value.named || []) L.push(`  - ${n.count}× [named] ${n.name}`);
      for (const t of es.value.top) L.push(`  - ${t.count}× ${t.prefix}`);
    } else {
      L.push(`- error scan: probe_failed — ${es.error}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// One read-only pass: gather probes, run the pure core, persist the sweep JSON + advance the
// watermark, and return the digest object + rendered markdown. Exported rather than inlined into
// main() because the hourly collector daemon used to drive it in-process; that daemon was retired
// 2026-07-29 (the app emits what it used to scrape), so `pnpm loop:sweep` is now the ONLY driver and
// the watermark advances once per pass rather than once an hour — which is the granularity the
// inter-pass deltas always wanted. A probe failure is data on the returned digest; only a tool-level
// crash throws.
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

  // Audits the loop's own record-keeping, not the stack — the only check here whose subject is this
  // repo. Merged into result.annotations before the digest is written so the finding is persisted in
  // the digest JSON too, not only printed: an unrecorded pass is exactly the fact a later pass has to
  // reconstruct from artifacts.
  result.annotations.push(
    ...classifyUnrecordedSweeps({ digestNames: listDigestNames(), logText: readPassLog() })
      .annotations,
  );

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

// CLI entry-point guard: run the sweep ONLY when executed directly. An `import` (the spec suite
// imports runSweep's siblings) must NOT fire a full blocking sweep as an import side effect.
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
