import type { PromotionReadiness } from '../../ports/promotion';

// SAFETY INVARIANT (hard interlock for the agentic lane, earned-live edition). The agentic /
// LLM-driven strategy is non-deterministic, so a LIVE-configured boot is refused unless the lane
// has EARNED it: an explicit PromotionReadiness verdict with permitted=true, computed from durable
// demo evidence (>=30 closed round trips AND positive net-of-cost PnL — LLM spend subtracted —
// over a >=14-day window; see PromotionReadinessService). Fail-closed in every other shape:
// no verdict (no DB, evaluation error, caller didn't supply one) or permitted=false both refuse,
// exactly as the pre-earned-live interlock always refused. A permitted verdict does NOT bypass the
// four-gate arming ceremony — ModeControl's env-flag/arming/key-probe/limits wall is untouched and
// still stands between a permitted boot and a live order.
//
// Gate on the STATIC live authority `configMode` — the same boundary that binds the live ccxt
// adapter — NOT on the boot-time-resolved effective mode. Why: at boot the bot is always unarmed
// (live arming is a runtime REQUEST→CONFIRM operation), so `effective` downgrades to 'paper'
// (NOT_ARMED) even when configMode==='live'. An effective-based check would therefore never fire at
// strategy-selection time, and a later runtime arm would let agentic intents (stamped mode='live'
// by the sizer, like every intent) pass the gate's mode check and reach the live venue. Refusing at
// boot on configMode closes that window before the agentic strategy is ever enabled.
export function assertAgenticLaneNotLive(
  activeStrategy: string,
  configMode: 'paper' | 'testnet' | 'live',
  readiness?: PromotionReadiness,
): void {
  if (activeStrategy !== 'agentic' || configMode !== 'live') return;
  if (readiness !== undefined && readiness.permitted) return;
  const detail =
    readiness === undefined
      ? 'no readiness verdict was available (fail-closed)'
      : `unmet criteria: ${readiness.evidence.reasons.join(', ')}`;
  throw new Error(
    'ACTIVE_STRATEGY=agentic refused at configMode=live: the earned-live promotion gate is not ' +
      `passed — ${detail}. Live requires >=30 closed demo round trips AND positive net-of-cost ` +
      'PnL over >=14 days (PromotionReadinessService), and then still the four-gate arming ceremony.',
  );
}
