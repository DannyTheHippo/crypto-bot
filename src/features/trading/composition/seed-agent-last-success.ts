import type { PromotionStatsPort } from '../../../ports/trading/promotion';

// Minimal shapes so the unit test needs neither the Nest TradingRuntimeModule graph nor a prom-client
// registry — same reason start-trading-failure.ts is its own module.
interface LastSuccessSink {
  seedLastSuccessAt(atMs: number): void;
}
interface SeedLog {
  log(message: string): void;
  warn(message: string): void;
}

// WATCH-V4-8 (2026-07-29). agent_last_success_timestamp_seconds is born at 0 on every process start,
// which is precisely the failure this metric exists to remove: an 08:17Z redeploy reset
// agent_client_latched to 0, cleared the critical latch alert and wiped the boot-scoped
// agent_decide_total series while both LLM provider accounts were still unfunded — a green board over
// a lane that had not reached the model since 07-27T20:15Z. Seeding from the durable journal is the
// shape already proven twice here: the daily cost breaker (seedDailyLlmBudget, f2d74b6) and
// reconciliation_last_success_timestamp_seconds.
//
// Fails OPEN, deliberately: no stats source (test/ci/no-DB), a port without the method (older fakes),
// or a throwing query leaves the gauge at 0 and logs, rather than blocking the boot. This is a
// MEASUREMENT input, never a safety interlock — a broken measurement must never refuse the thing it
// measures — and 0 is itself the honest reading ("no successful decide on record"), which the
// staleness alert already treats as stale.
export async function seedAgentLastSuccess(
  recorder: LastSuccessSink,
  log: SeedLog,
  stats?: Pick<PromotionStatsPort, 'lastSuccessfulDecideAt'>,
  nowMs: number = Date.now(),
): Promise<void> {
  if (stats?.lastSuccessfulDecideAt === undefined) return;
  try {
    const atMs = await stats.lastSuccessfulDecideAt();
    if (atMs === null) {
      log.log(
        'agentic liveness seed: agent_decisions holds no completed model round trip — gauge stays at 0 (never)',
      );
      return;
    }
    recorder.seedLastSuccessAt(atMs);
    log.log(
      `agentic liveness seeded from the durable journal: last completed model round trip ` +
        `${new Date(atMs).toISOString()} (${((nowMs - atMs) / 3_600_000).toFixed(1)}h ago)`,
    );
  } catch (err) {
    log.warn(
      `agentic liveness seed failed (${err instanceof Error ? err.message : String(err)}) — ` +
        `agent_last_success_timestamp_seconds stays at 0 until this boot's first successful decide`,
    );
  }
}
