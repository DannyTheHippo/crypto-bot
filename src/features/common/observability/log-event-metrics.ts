import pino from 'pino';
import { Counter, register } from 'prom-client';

// Replaces the loop collector's `errorScan` probe, which tailed `docker logs` for level>=40 pino
// lines. That surface had two unfixable holes: the tail is a LINE bound (20k lines was ~12h at this
// stack's rate) and the json-file log is DELETED on every container recreate, so a redeploy erased
// the window the pass was about to read. A counter lives in the TSDB, survives recreates, and is
// alertable (AppErrorLogRateElevated, observability/alerts.rules.yml).
//
// Scope is warn/error/fatal (level >= 40) — exactly what errorScan matched. Routine info lines are
// deliberately NOT counted: they carry the widest message variety and would burn the cardinality cap
// on request logs while adding nothing the liveness gauges do not already show.
const MIN_COUNTED_LEVEL = 40;

// Hard cardinality ceiling. Prefixes are derived from free-text log messages, so an unbounded label
// would let one badly-formatted message family blow up the TSDB. Past the cap every new key folds
// into `other` — the count stays honest, only the breakdown saturates.
const MAX_EVENT_KEYS = 60;
const OTHER_EVENT = 'other';
const UNLABELED_EVENT = 'unlabeled';
const MAX_EVENT_LENGTH = 48;

const APP_LOG_EVENTS_METRIC = 'app_log_events_total';

// Zero-valued child so a QUIET app still exports a series. prom-client only materialises a labeled
// child when it is touched, so without this an app with no warnings exports nothing at all — and an
// empty instant vector is indistinguishable from a renamed or unwired metric (playbook §C.9
// negative-read void; the same trap that made loop:sweep annotate probe_failed[wsRecreations] on
// every sweep until metrics.service.ts started publishing an explicit zero).
const NONE_EVENT = 'none';
const MATERIALIZED_LEVELS = ['warn', 'error', 'fatal'] as const;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Collapses a free-text log message into a bounded, stable label value: lowercased, with UUIDs and
 * digit runs stripped (they are per-event identifiers, not event kinds), non-alphanumerics folded to
 * single underscores, and truncated. Two lines about the same failure land on the same key even when
 * they carry different order ids, symbols with digits, or durations.
 */
export function createLogEventNormalizer(
  maxKeys: number = MAX_EVENT_KEYS,
): (msg: unknown) => string {
  const seen = new Set<string>();
  return (msg: unknown): string => {
    if (typeof msg !== 'string') return UNLABELED_EVENT;
    const key = msg
      .toLowerCase()
      .replace(UUID_RE, '')
      .replace(/\d+/g, '')
      .replace(/[^a-z]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, MAX_EVENT_LENGTH)
      .replace(/_+$/, '');
    if (key.length === 0) return UNLABELED_EVENT;
    if (seen.has(key)) return key;
    if (seen.size >= maxKeys) return OTHER_EVENT;
    seen.add(key);
    return key;
  };
}

const normalize = createLogEventNormalizer();

/**
 * Pulls the human message out of a pino call's raw argument list. pino accepts `(msg)`,
 * `(obj, msg)`, `(obj)` with an embedded `msg`, and `(err)` — all four appear in this codebase.
 */
export function resolveLogMessage(args: readonly unknown[]): unknown {
  for (const candidate of args.slice(0, 2)) {
    if (typeof candidate === 'string') return candidate;
  }
  const first = args[0];
  if (first !== null && typeof first === 'object') {
    const asRecord = first as { msg?: unknown; message?: unknown };
    if (typeof asRecord.msg === 'string') return asRecord.msg;
    if (typeof asRecord.message === 'string') return asRecord.message;
  }
  return undefined;
}

// Looked up rather than cached: a test that clears the default registry between cases would otherwise
// hold a counter registered to a dead registry. getSingleMetric is a Map read.
function logEventsCounter(): Counter<string> {
  const existing = register.getSingleMetric(APP_LOG_EVENTS_METRIC);
  if (existing) return existing as Counter<string>;
  return new Counter({
    name: APP_LOG_EVENTS_METRIC,
    help: 'Pino log lines at warn/error/fatal, by level and normalized message key',
    labelNames: ['level', 'event'] as const,
    registers: [register],
  });
}

/**
 * Publishes the zero-valued children so a quiet app exports real series. Called once from
 * MetricsService.onModuleInit.
 */
export function materializeLogEventSeries(): void {
  try {
    const counter = logEventsCounter();
    for (const level of MATERIALIZED_LEVELS) {
      counter.inc({ level, event: NONE_EVENT }, 0);
    }
  } catch {
    // Fails OPEN — see recordLogEvent.
  }
}

/**
 * Counts one pino line. Failure direction: OPEN. This sits on the hot logging path, so a metrics
 * fault must never swallow a log line or throw into a caller that was only trying to log — every
 * failure is absorbed and the line still gets written by the hook that calls this.
 */
export function recordLogEvent(level: number, args: readonly unknown[]): void {
  try {
    if (level < MIN_COUNTED_LEVEL) return;
    const levelLabel = pino.levels.labels[level] ?? 'unknown';
    logEventsCounter()
      .labels({ level: levelLabel, event: normalize(resolveLogMessage(args)) })
      .inc();
  } catch {
    // Measurement must never break the thing it measures.
  }
}
