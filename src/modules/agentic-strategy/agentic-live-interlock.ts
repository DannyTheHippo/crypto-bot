// SAFETY INVARIANT (hard interlock for the agentic lane). The agentic / LLM-driven strategy is
// non-deterministic and permanently EXPERIMENT-ONLY (step-D-uncertifiable), so it must NEVER run in a
// LIVE-configured process. Gate on the STATIC live authority `configMode` — the same boundary that binds
// the live ccxt adapter — NOT on the boot-time-resolved effective mode.
//
// Why configMode and not resolveMode().effective: at boot the bot is always unarmed (live arming is a
// runtime REQUEST→CONFIRM operation), so `effective` downgrades to 'paper' (NOT_ARMED) even when
// configMode==='live'. An effective-based check would therefore never fire at strategy-selection time,
// and a later runtime arm would let agentic intents (stamped mode='live' by the sizer, like every
// intent) pass the gate's mode check and reach the live venue. Refusing at boot on configMode closes
// that window before the agentic strategy is ever enabled.
export function assertAgenticLaneNotLive(
  activeStrategy: string,
  configMode: 'paper' | 'testnet' | 'live',
): void {
  if (activeStrategy === 'agentic' && configMode === 'live') {
    throw new Error(
      'ACTIVE_STRATEGY=agentic is forbidden when configMode=live: the agentic lane is EXPERIMENT-ONLY ' +
        '(non-deterministic, step-D-uncertifiable) and never crosses the live gate.',
    );
  }
}
