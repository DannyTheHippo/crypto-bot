import type { Price } from './money';
import type { StrategyId, VenueId, SymbolId, EpochMs } from './ids';

export interface Signal {
  readonly strategyId: StrategyId;
  readonly venue: VenueId;
  readonly symbol: SymbolId;
  readonly kind:
    | 'ENTER_LONG'
    | 'EXIT_LONG'
    | 'ENTER_SHORT'
    | 'EXIT_SHORT'
    | 'FLATTEN'
    | 'CANCEL_OPEN';
  readonly strength: number;
  // Only meaningful on kind CANCEL_OPEN: scopes the cancel to one side. Absent ⇒ cancel both sides
  // (today's behavior, unchanged) — see SignalSinkService.cancelOpenForSignal.
  readonly cancelSide?: 'BUY' | 'SELL';
  // Push 3 P7c: role-scoped narrowing alongside cancelSide — 'vtp' cancels only the resting
  // take-profit, 'vsl' only the resting protective stop (role resolved off the order's own intent
  // dedupeKey — see SignalSinkService.cancelOpenForSignal / domain/oms/resting-order-role.ts).
  // Absent ⇒ every order matching cancelSide is cancelled (today's behavior, unchanged) — this is
  // the deliberate path for a cancel-first ahead of a full-size exit, which must clear BOTH a
  // resting TP and a resting stop.
  readonly cancelRole?: 'vtp' | 'vsl';
  readonly limitPriceHint?: Price;
  // Protective-stop hint (Push 3 P7b): a reduce-only exit signal with exitStyle 'RESTING_STOP' rests
  // a venue trigger order (STOP_MARKET on a perp, STOP_LOSS_LIMIT on spot) built off this trigger
  // price instead of the plain limit/crossing paths above — see PositionSizerService.size.
  // limitPriceHint is unused on this exitStyle (the sizer derives the spot limit leg from the
  // trigger itself, buffered by STOP_LIMIT_BUFFER_BPS).
  readonly triggerPriceHint?: Price;
  // Passive-exit hint (plan-mode take-profit): a reduce-only exit signal with exitStyle 'RESTING'
  // rests at limitPriceHint (GTC) instead of crossing the spread; absent hint falls back to the
  // existing IOC crossing path — see PositionSizerService.size. 'RESTING_STOP' (Push 3 P7b) is a
  // distinct protective-stop variant keyed off triggerPriceHint instead — see that field's comment.
  readonly exitStyle?: 'RESTING' | 'RESTING_STOP';
  // Defect B (#49) fix: compounds a side-scoped cancel-first with THIS signal's own submission into
  // ONE SignalSinkService chain entry (see SignalSinkService.processSignal) — a resting venue TP/stop
  // otherwise locks the base a concurrent protective/marketable exit needs, and emitting the cancel
  // and the exit as two separate recordSignal calls (today's ProtectiveExitService.fire / the agentic
  // stop/max_hold path, pre-fix) left a same-key-signal-sized interleave window where a third signal
  // (e.g. a TP re-placement) could re-lock the base between them. Absent ⇒ byte-identical to today —
  // no cancel-first, straight to the gateway/submit path.
  readonly cancelBeforeSubmit?: { readonly side: 'BUY' | 'SELL' };
  readonly refPrice: Price;
  readonly basedOnSeq: bigint;
  readonly eventTime: EpochMs;
  readonly ttlMs: number;
  readonly dedupeKey: string;
  readonly reason: string;
}
