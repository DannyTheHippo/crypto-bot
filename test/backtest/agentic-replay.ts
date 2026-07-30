// LLM-in-the-loop walk-forward backtest — ASYNC bar-walk engine — RESEARCH TOOLING (test/backtest/,
// off the production gate). The offline verifier that turns candidate playbook/model evaluation from
// live-throughput-bound (one real decide per bot cadence) into an on-demand, budget-capped run.
//
// v3 RICH DECISION CONTRACT, WITH SHORTS (2026-07-22). This engine serves production's OWN
// submit_trade contract: buildTradeTool(caps)/buildSystemPrompt from agent-prompt.ts and
// tradeDecisionSchema from anthropic-agent-client.ts, imported — never re-declared. The local legacy
// submit_plan tool, its PLAN_BOUNDS, its reconstructed plan-mode system prompt, and the local
// planSchema mirror are DELETED: pinning this harness to a wire shape production no longer serves
// made every scorecard a measurement of a contract nothing runs. Both directions are live —
// capabilities.shorts is derived per symbol exactly as the production client derives it (a
// ':'-settled ccxt linear-swap id is a perp, and perps are shorts-capable), so an 'open_short' on a
// perp symbol opens a real SELL-to-open position settled through the same domain machinery.
//
// >>> SCORECARDS PRODUCED AFTER THIS CHANGE ARE NOT COMPARABLE TO PRE-v3 PLAN-MODE SCORECARDS. <<<
// Different tool schema, different system prompt, different action vocabulary, and a two-sided
// opportunity set: a net-bps or sign-consistency number from a plan-mode run and one from a v3 run
// are measurements of two different systems, not two samples of one.
//
// FAIR-PROXY EVIDENCE BASIS (2026-07-12, candidates/degradation-2026-07-12.json): an OHLCV-only
// prompt (orderBook/ticker stripped) reproduces live decides at 93.3% action agreement with
// negligible plan-field deltas — see test/eval/agentic/payload-degradation-live.spec.ts, the live
// pre-check this backtest's premise rests on. That measurement was taken on the PLAN-MODE contract;
// it is carried forward as the reason OHLCV-only is a defensible proxy shape at all, NOT as a
// re-measured v3 agreement figure. This module therefore still NEVER attaches orderBook/ticker/
// derivatives to a payload (see the decision input below) — every scorecard it produces is labeled a
// FAIR-PROXY result, not a ground-truth reproduction of live decides.
//
// TRAINING-CUTOFF FLOOR: claude-sonnet-5's training cutoff is January 2026. Any bar dated before
// EARLIEST_ALLOWED_MS (2026-02-01T00:00:00Z) risks a memorization confound (the model recognizing
// price action it was trained on rather than reasoning from the payload) — runAgenticReplay refuses
// outright if the first supplied bar predates the floor (see the guard below); the caller
// (scripts/backtest-agentic.mjs) is expected to have already sliced/clamped to it, this is defense in
// depth, not the primary enforcement point. The floor is dated for the CHAMPION model; a routed
// third-party model (see PER-MODEL ROUTING) may have a different cutoff, which the floor does not
// know about — a head-to-head across models with different cutoffs is confounded in the direction of
// whichever model saw the window.
//
// ORCHESTRATION SPLIT with strategies/live-agentic-strategy.ts (read that file's header first): THIS
// module owns everything live-agentic-strategy.ts cannot — the async model call (fetch, cache_control
// blocks, thinking disabled, same request shape as the live client), the v3 schema validation and
// fee/RR floor mapping, the $ budget ledger, and REAL domain settlement (applyFillToPosition +
// walkRoundTrips, net of fees) — it prices every fill and picks BUY/SELL from the action's direction.
// live-agentic-strategy.ts owns the ONE evaluatePlan orchestration path (resting-entry wait, mirrored
// fill DETECTION, managed-exit checks) and returns bare enter{side}/exit/hold — never a price.
//
// PER-MODEL ROUTING + PRICING: the endpoint, key, pacing, and $/MTok rates for a model come from
// test/shared/model-routing.ts — the SAME module test/eval/agentic's head-to-head eval uses, so a
// kimi-vs-sonnet comparison is routed and priced identically in both harnesses. A key is resolved by
// env-var NAME and is never logged or echoed (CLAUDE.md rule 7).
//
// FLOORS: applyFloors below applies the same fee-aware edge/RR/stop floor SHAPE this harness has
// always had (minEdgeMultiple x round-trip fee fraction, stop >= fee fraction, TP/SL >= minRr), but as
// of the 2026-07-22 fidelity fix its DEFAULTS (minEdgeMultiple '1', minRr '0') collapse the edge and RR
// checks onto the SAME single gate production still enforces (anthropic-agent-client.ts:1435-1462 —
// takeProfitPct >= the round-trip fee fraction, nothing more): AGENTIC_MIN_EDGE_MULTIPLE and
// AGENTIC_MIN_RR were themselves retired 2026-07-18 (.env.app:145, agentic-strategy.module.ts:168), so
// a harness that kept its pre-retirement 1.5 defaults was measuring its OWN stale-knob preference
// instead of model edge — a model habitually proposing RR 1.2-1.4 booked zero round trips against one
// clearing 1.5, which has nothing to do with either model's actual edge. minEdgeMultiple/minRr stay
// CALLER-tunable (a deliberate stricter sweep is still a legitimate research use), but the shipped
// default now matches what a live decide actually enforces. Every rejection is still COUNTED in
// decisionOutcomeCounts rather than silently masked as a hold (the exact failure mode the 2026-07-22
// production schema-hardening pass fixed: a masked degrade is indistinguishable from a deliberate hold
// in the aggregate).
//
// WALK-FORWARD PROTOCOL: the playbook/model IS the candidate — nothing here fits a parameter to the
// data (no stop/TP/entry-offset optimization loop; those are the MODEL's own per-bar proposals).
// Splitting the window into K sequential segments and reporting per-segment sign consistency is
// therefore honest out-of-sample BY CONSTRUCTION, not because of a train/test split — there is no
// "train" phase to hold out from. See computeSegmentStats below.
//
// HTF (h1/h4) IS wired (aggregateCandles is a pure src/domain function, cleanly importable) — it
// naturally evaluates to {h1:null,h4:null} at the default 4h timeframe because HTF_TARGET_MS.h4 ===
// the base interval (factor 1, below the aggregateCandles fold's factor>=2 floor) and h1 is SHORTER
// than the base interval (non-integer factor) — this is production-faithful (agentic.strategy.ts's
// buildHtfIndicators has the exact same factor>=2 guard), not an omission of this module.
//
// FILL MODEL (see live-agentic-strategy.ts's header for the full rationale): a maker entry fills at
// entryOffsetBps below (LONG) / above (SHORT) the plan-creation bar's close, on the first later bar
// whose LOW (LONG) / HIGH (SHORT) crosses that price; a taker entry fills immediately at the plan
// bar's own close. Exits are ASYMMETRIC by design, each taking the pessimistic side (2026-07-22
// fidelity fix 3):
//   • stop / max_hold fill at the triggering bar's own CLOSE. evaluatePlan's stop check is
//     close-triggered, and by the time a close confirms the breach price has already traded through —
//     filling at the exact stopPrice would book a better exit than that bar's information supports.
//   • take_profit fills at takeProfitPrice, NOT the close. The close is always at least as favourable
//     as the TP trigger (evaluatePlan fires on close >= TP for a LONG / <= TP for a SHORT), so filling
//     at the close would harvest free edge the venue never gives: production rests a limit TP at the
//     venue (.env.app AGENTIC_VENUE_TP=true), which CAPS the fill at takeProfitPrice. Here, unlike for
//     a stop, filling at the plan's own price is the pessimistic side — and it also removes a bias that
//     was not symmetric across models, since a model favouring tight, frequently-overshot TPs harvested
//     more phantom edge than one setting wide ones.
// Every fill is charged a flat settlementFeeBps (default 10bps) per leg, settled through
// the REAL domain PnL machinery (applyFillToPosition, src/domain/trading/oms/position.ts) exactly like
// harness.ts — a SHORT is SELL-to-open then BUY-to-close through that same signed-position code.
//
// BUDGET: usage is priced per model from test/shared/model-routing.ts's rate table (per-model
// overrides first, then the published Anthropic defaults, then a sonnet-tier fallback) and
// accumulated after every call. Once accumulated spend >= maxUsd, the run ABORTS CLEANLY at the top
// of the next bar (no further bar is processed, no further $ can be spent) — `aborted: true` and a
// partial scorecard are always returned, never thrown; callers must not treat a partial run's
// sign-consistency as if the window had been fully walked.
//
// FUNDING (perp carry, 2026-07-22 funding-accounting fix): a PERP run is now genuinely NET OF FUNDING —
// scorecard.pnl.netQuote/netOfLlmSpendQuote include it, and scorecard.pnl.fundingQuote/fundingLong/
// fundingShort break it out as its own line item (never mixed into feesQuote). A SPOT run carries NO
// funding by construction (funding stays exactly '0', byte-identical to this module's pre-fix
// behaviour) — spot symbols simply have none to accrue. Accrual timestamps are read STRICTLY from the
// cached funding series itself (test/backtest/data/funding-<symbol>.json, the same file
// test/backtest/fetch-data.mjs's --funding flag writes) — never an invented per-bar schedule — and
// applied against whatever position survived this bar's own fill handling, at this bar's own close, via
// test/backtest/funding.ts's fundingPayment (that module owns the sign convention: a positive rate
// charges a long, credits a short). A PERP symbol with NO cached funding file REFUSES the run outright
// (see loadFundingRowsFromDisk) rather than silently trading it at zero funding — a silent zero here is
// exactly the systematic long/short bias this fix exists to remove from the upcoming model bake-off.
// MODEL PAYLOAD: production only ever sends a fundingRate to the model inside the derivatives block
// (agent-prompt.ts's buildDerivativesBlock), which renders NOTHING unless a live DerivativesSnapshot
// rode in on input.snapshot.derivatives — and this harness's decision `input` below NEVER sets that
// field (see the FAIR-PROXY EVIDENCE BASIS note above: orderBook/ticker/derivatives are deliberately
// never attached). The model-facing payload is therefore UNCHANGED by this fix — that omission already
// matches what a real decide would send under the same (no derivatives feed attached) condition, so
// wiring a funding number into it here would show the model something a live decide would not.
import Decimal from 'decimal.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  setupDecimal,
  roundToStep,
  toIndicatorNumber,
  price,
  qty,
} from '../../src/domain/common/types/money';
import {
  applyFillToPosition,
  FLAT,
  type PositionState,
} from '../../src/domain/trading/oms/position';
import {
  walkRoundTrips,
  type RoundTripFill,
  type ClosedRoundTrip,
} from '../../src/domain/trading/risk/round-trips';
import { takerFeeQuote } from './fill-models';
import { fundingPayment } from './funding';
import { aggregateCandles } from '../../src/domain/strategy/indicators/candle-aggregate';
import {
  emaFromNumbers,
  rsiFromNumbers,
  atrFromNumbers,
  pctChange,
} from '../../src/domain/strategy/indicators/indicators';
import {
  epochMs,
  symbolId,
  venueId,
  strategyId,
  type SymbolId,
} from '../../src/domain/common/types/ids';
import { splitSymbol } from '../../src/domain/venue/types/symbol';
import { PERP_VENUE_ID, venueForSymbol } from '../../src/domain/venue/types/venue-map';
import type { CandleEvent, CandleInterval } from '../../src/domain/venue/types/market-events';
import type {
  AgentDecisionInput,
  AgentDirectives,
  AgentIndicators,
  AgentHtfIndicators,
  AgentPositionSummary,
  AgentTradingProfile,
} from '../../src/ports/strategy/agentic-strategy';
import {
  buildMarketPayload,
  buildPlaybookBlock,
  buildSystemPrompt,
  buildTradeTool,
  type SymbolCapabilities,
} from '../../src/features/strategy/agentic/agent-prompt';
import { tradeDecisionSchema } from '../../src/features/strategy/agentic/anthropic-agent-client';
import {
  apiKeyEnvNameFor,
  callCostUsd,
  parseModelRoutes,
  parseTokenPriceOverrides,
  resolveRate,
  resolveRouteFrom,
  type CallUsage,
  type ModelRoute,
} from '../shared/model-routing';
import {
  LiveAgenticStrategy,
  type LiveAgenticBudget,
  type MappedDecision,
  type PositionDirection,
} from './strategies/live-agentic-strategy';
import type { BarStrategy } from './strategy';
import type { Bar } from './harness';

setupDecimal(); // production Decimal config (precision 40, ROUND_HALF_EVEN) — mirrors harness.ts

// ── Training-cutoff floor ─────────────────────────────────────────────────────
export const EARLIEST_ALLOWED_ISO = '2026-02-01T00:00:00.000Z';
export const EARLIEST_ALLOWED_MS = Date.parse(EARLIEST_ALLOWED_ISO);

// Mirrors agentic.strategy.ts's local (not exported) INTERVAL_MS/HTF_TARGET_MS/INDICATOR_WARMUP_CLOSES
// so this module computes indicators/htf identically to production — re-check both on any drift there.
const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};
const HTF_TARGET_MS: Record<'h1' | 'h4', number> = { h1: 3_600_000, h4: 14_400_000 };
const INDICATOR_WARMUP_CLOSES = 21;

// Pins what a LIVE decide actually advertises, which is the deployed .env.app value — not
// anthropic-agent-client.ts's DEFAULT_* fallbacks, which only apply when the knob is absent (same
// local-redeclaration precedent as test/eval/agentic/trade-eval-fixtures.ts's SYNTHETIC_PERP_CAPS).
// Those two diverged at the 2026-07-27 leverage change: the zod/client default stays '2' while
// .env.app pins '5', so mirroring the default here would understate the live cap. A backtest must
// advertise a symbol exactly what a live decide advertises it, or the model is answering a different
// question — re-check against .env.app on any drift.
const MAX_POSITION_FRACTION_SPOT = '0.15';
const MAX_POSITION_FRACTION_PERP = '0.35';
const PERP_LEVERAGE_CAP = '5';

// Mirrors anthropic-agent-client.ts's local (not exported) EPHEMERAL_1H — the same 1h cache TTL, so a
// multi-bar replay run (many sequential calls sharing one system prompt + playbook prefix) actually
// hits cache_read after the first call, matching production's own cache-reuse rationale.
const EPHEMERAL_1H = { type: 'ephemeral', ttl: '1h' } as const;
interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: typeof EPHEMERAL_1H;
}

const FLAT_POSITION_SUMMARY: AgentPositionSummary = {
  side: 'FLAT',
  qty: '0',
  avgEntry: null,
  realizedPnl: '0',
  unrealizedPnlPct: null,
  openOrders: 0,
};

// ── Options / result shapes ───────────────────────────────────────────────────

// One cached funding settlement — the SAME shape test/backtest/fetch-data.mjs's
// fetchFundingHistoryPaged writes (fundingRate persisted as a decimal STRING, never a bare float).
export interface FundingRow {
  readonly timestamp: number;
  readonly fundingRate: string;
}

export interface AgenticReplayOpts {
  readonly symbol: string; // e.g. 'BTC/USDT' (spot) or 'BTC/USDT:USDT' (perp ⇒ shorts enabled)
  // Cosmetic (CandleEvent envelope field only) — the symbol's OWN venue (venueForSymbol) is what
  // decides capabilities, never this. Absent ⇒ the derived venue.
  readonly venue?: string;
  readonly interval: CandleInterval;
  // Already sliced to the caller's --from/--to window; runAgenticReplay refuses if bars[0] predates
  // EARLIEST_ALLOWED_MS (defense in depth — see file header).
  readonly bars: readonly Bar[];
  readonly playbookContent?: string;
  readonly model: string;
  // The DEFAULT-route key. A model whose route names its own baseUrl must name its own apiKeyEnv
  // instead (see test/shared/model-routing.ts) — this key is then never sent to that host.
  readonly apiKey: string;
  readonly maxUsd: string; // decimal string hard $ budget — REQUIRED, no default
  // Per-model routing/pricing JSON, same shapes the eval lane's AGENTIC_EVAL_MODEL_ROUTES_JSON /
  // AGENTIC_TOKEN_PRICES_JSON carry. Absent ⇒ default Anthropic route, published default rates.
  readonly modelRoutesJson?: string;
  readonly tokenPricesJson?: string;
  readonly segments?: number; // default 3
  // The account equity this run's entries are sized against. entryNotional = equityBase x
  // directives.sizeFraction (Fix 1, 2026-07-22 fidelity pass) — the same formula production's
  // PositionSizerService applies for the agentic lane's own sizing directive (position-sizer.
  // service.ts's sizeFractionNotional: notional = cappedEquity x min(sizeFraction, maxFraction); the
  // min() is a no-op here because callModel's tradeDecisionSchema(maxSizeFraction) already rejects any
  // sizeFraction above the symbol's own cap before a decision reaches this loop, so re-clamping would
  // be a second policy, not a mirror of one). Defaults to the deployed SIZER_EQUITY_CAP (.env.app:189)
  // so an offline scorecard sizes like the book it is meant to predict. Before this fix every accepted
  // entry booked a FLAT equityBase-sized notional regardless of the model's own conviction — two
  // models with identical direction calls and opposite sizing discipline produced byte-identical
  // scorecards, and llmSpendUsd (an absolute $ figure) was compared against a netQuote inflated by a
  // per-decision factor unrelated to what the model actually sized (live books a max-conviction spot
  // entry near equityBase x 0.15 ≈ $150; the pre-fix harness booked the full $1000 flat).
  readonly equityBase?: string; // default '1000'
  // Display-grade only (rendered into the payload's capabilities block, never enforced) — default is
  // equityBase, i.e. "this run's book has room for exactly the equity it sizes against".
  readonly venueFreeCash?: string;
  // default '1' — AGENTIC_MIN_EDGE_MULTIPLE was RETIRED 2026-07-18 (.env.app:145). '1' collapses this
  // floor onto exactly the round-trip fee fraction, i.e. no floor beyond what production's own
  // takeProfitPct >= feeFraction gate already requires. Caller-tunable for a deliberate stricter
  // sweep, but '1' is what a live decide actually enforces.
  readonly minEdgeMultiple?: string;
  // default '0' — AGENTIC_MIN_RR was likewise retired 2026-07-18. '0' makes the RR check unreachable
  // (a valid TP/SL ratio is always > 0), matching production, which enforces no RR floor at all.
  readonly minRr?: string;
  readonly makerBps?: string; // default '10' — feeds the floor's round-trip fee fraction
  readonly takerBps?: string; // default '10'
  readonly settlementFeeBps?: string; // default '10' — flat per-leg fee charged on every fill
  // default 4096 — matches AGENTIC_MAX_TOKENS's deployed value. NOT the legacy 1024: the v3
  // forced-tool response is larger, and 1024 truncated 32% of proposes into schema-invalid holds in
  // the 2026-07-22 sonnet eval leg.
  readonly maxTokens?: number;
  readonly maxDecisions?: number; // default 1_000_000 — coarse price-independent safety ceiling
  // Injectable — offline specs supply a scripted stub so this module never needs a real network call
  // or API key (mirrors AnthropicAgentClient's own fetchFn constructor param).
  readonly fetchFn?: typeof fetch;
  // Injectable env for route key lookup (route.apiKeyEnv indirection). Defaults to process.env.
  readonly env?: Record<string, string | undefined>;
  // PERP-ONLY. Injectable override for offline specs (same rationale as fetchFn/env above) — bypasses
  // the on-disk funding cache entirely, letting a test pin an exact, controlled funding schedule
  // instead of depending on whatever the live-fetched cache file currently contains. Omitted ⇒ loaded
  // from test/backtest/data/funding-<symbol, '/' and ':' stripped>.json, REFUSING loudly if that file
  // is absent (see loadFundingRowsFromDisk) — a missing cache is never silently treated as zero
  // funding (see the file header's FUNDING note). Always ignored for a spot symbol — fundingRows is
  // unconditionally [] there regardless of this option.
  readonly fundingRows?: readonly FundingRow[];
}

export interface AgenticReplaySegmentStats {
  readonly fromBarIndex: number;
  readonly toBarIndex: number; // exclusive
  readonly roundTrips: number;
  readonly netBpsPerRoundTrip: string | null; // mean, fee-inclusive
  readonly winRate: number | null;
  readonly meanHoldBars: number | null;
  readonly maxDrawdownPct: string;
  readonly sign: 'positive' | 'negative' | 'flat' | 'n/a';
}

// Per-direction closed-trip breakdown. Money fields are EXACT strings (CLAUDE.md rule 1) — never
// rounded for display here; a consumer that wants 2dp rounds at print time.
export interface AgenticReplayDirectionStats {
  readonly roundTrips: number;
  readonly winRate: number | null;
  readonly netPnlQuote: string; // realized − fees, summed over this direction's closed trips
}

// Per-direction funding cash-flow breakdown — mirrors AgenticReplayDirectionStats' shape (a nested
// per-direction object alongside long/short) but without roundTrips/winRate fields, which don't mean
// anything for a pure carry cash flow rather than a round-trip's win/loss.
export interface AgenticReplayFundingStats {
  readonly events: number; // funding settlements accrued while a position of this direction was open
  readonly netQuote: string; // net PnL contribution — negative = net paid, positive = net received
}

export interface AgenticReplayPnl {
  // Summed over CLOSED round trips only — an open position at the end contributes nothing (see
  // openPositionAtEnd, which flags exactly that case).
  readonly realizedQuote: string; // GROSS of fees (walkRoundTrips' own convention)
  readonly feesQuote: string;
  // Perp-carry funding, accrued against the OPEN position at every cached funding timestamp inside the
  // hold (see the file header's FUNDING note) — its OWN line item, never mixed into feesQuote. SIGN is
  // the position holder's PnL contribution: negative = net PAID, positive = net RECEIVED (mirrors
  // test/backtest/funding.ts's fundingPayment convention exactly). Always '0' for a spot symbol.
  readonly fundingQuote: string;
  readonly netQuote: string; // realized − fees + fundingQuote — genuinely net of funding
  readonly llmSpendUsd: string;
  // netQuote − llmSpendUsd. The two are added across units: PnL is in the pair's QUOTE asset, spend
  // is USD. For the USDT-quoted book this program trades those are ~1:1; on a non-USD-quote pair
  // this figure is an approximation, not an exchange-rate conversion.
  readonly netOfLlmSpendQuote: string;
  readonly long: AgenticReplayDirectionStats;
  readonly short: AgenticReplayDirectionStats;
  // fundingQuote split by the direction of the position it accrued against. Always {0, '0'} for spot.
  readonly fundingLong: AgenticReplayFundingStats;
  readonly fundingShort: AgenticReplayFundingStats;
}

// Why every model call ended. NOT a diagnostic afterthought: a hold that came from a floor rejection,
// a capability violation, a schema failure, or a transport error is a DIFFERENT event from a hold the
// model deliberately chose, and collapsing them is how a broken contract reads as a cautious model.
export type AgenticReplayDecisionOutcome =
  | 'accepted' // open_long/open_short whose directives cleared every floor
  | 'hold'
  | 'close' // 'close' while FLAT — a no-op in this single-position harness
  | 'adjust' // 'adjust' while FLAT — no directive set exists to revise
  | 'floor_rejected'
  | 'capability_rejected' // open_short on a shorts:false (spot) symbol
  | 'schema_rejected' // 200 OK, but no usable submit_trade payload
  // Fix 4 (2026-07-22 fidelity pass, XA4 parity — anthropic-agent-client.ts:707-722): a max_tokens
  // stop with NO tool_use block at all — the model ran out of output budget before emitting the call.
  // Distinct from schema_rejected (a tool_use block WAS emitted but failed validation): collapsing the
  // two hides exactly the distinction the 2026-07-22 production contract-hardening pass exists to
  // preserve — a masked truncation reads as a model that structurally can't decide, when the real fix
  // is raising maxTokens.
  | 'truncated'
  | 'call_failed'; // transport/HTTP failure — no usable response at all

// Fix 1 (2026-07-22 fidelity pass): names the formula a scorecard's notional-derived figures
// (netQuote, netBpsPerRoundTrip, netOfLlmSpendQuote) were computed under, so no consumer comparing two
// scorecards can misread a differing equityBase as a differing edge.
export interface AgenticReplaySizingModel {
  readonly kind: 'sizeFraction-of-equityBase';
  readonly equityBaseQuote: string;
}

export interface AgenticReplayResult {
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly model: string;
  readonly shortsEnabled: boolean; // capabilities.shorts for this symbol
  readonly fromTs: number;
  readonly toTs: number;
  readonly barsSupplied: number;
  readonly barsUsed: number; // bars actually walked before completion/abort
  readonly decisionsRequested: number; // model calls actually made
  readonly decisionsAccepted: number; // calls that resulted in a floors-passing open_* directive set
  readonly decisionOutcomeCounts: Readonly<Record<AgenticReplayDecisionOutcome, number>>;
  readonly spendUsd: string;
  readonly maxUsd: string;
  readonly aborted: boolean;
  readonly abortReason: 'ABORTED_BUDGET' | null;
  readonly openPositionAtEnd: boolean;
  readonly exitReasonCounts: {
    readonly stop: number;
    readonly take_profit: number;
    readonly max_hold: number;
  };
  readonly pnl: AgenticReplayPnl;
  readonly segments: readonly AgenticReplaySegmentStats[];
  readonly totals: AgenticReplaySegmentStats;
  // Fix 1: the formula/equityBase every notional-derived pnl figure above was computed under — see
  // AgenticReplaySizingModel's own comment.
  readonly sizingModel: AgenticReplaySizingModel;
  // See file header — every scorecard from this module is an OHLCV-only FAIR-PROXY result on the v3
  // contract, never a live-decide reproduction and never comparable to a pre-v3 plan-mode scorecard.
  readonly fairProxyNote: string;
}

export const FAIR_PROXY_NOTE =
  'OHLCV-only fair-proxy backtest on the v3 submit_trade contract (orderBook/ticker/derivatives never ' +
  'attached to the payload) — the 93.3% live action agreement measured 2026-07-12 ' +
  '(candidates/degradation-2026-07-12.json) was taken on the LEGACY plan-mode contract and justifies ' +
  'the OHLCV-only payload shape only; it is not a re-measured v3 agreement figure. NOT comparable to ' +
  'pre-v3 plan-mode scorecards.';

// ── Funding (perp carry) ───────────────────────────────────────────────────────
// See the file header's FUNDING note for the accrual rule and sign convention. Loading is symbol-keyed
// against the SAME on-disk cache test/backtest/fetch-data.mjs's --funding flag writes (its safeName
// strips '/' and ':', e.g. 'BTC/USDT:USDT' -> 'BTCUSDTUSDT') — never a second, independently-maintained
// path, mirroring test/backtest/carry/carry-grid.ts's own carryDataPath convention.
const FUNDING_DATA_DIR = join(__dirname, 'data');

function fundingFilePathFor(symbol: string): string {
  return join(FUNDING_DATA_DIR, `funding-${symbol.replace(/[/:]/g, '')}.json`);
}

// FAILS LOUDLY (never returns []) when the cache is absent — see the file header's FUNDING note: a
// silent zero here is exactly the long/short bias this fix exists to remove from the bake-off it feeds.
// Trusts the cached shape (the same contract fetch-data.mjs's fetchFundingHistoryPaged writes) rather
// than re-validating field-by-field, matching carry-grid.ts's loadCarryFunding precedent.
function loadFundingRowsFromDisk(symbol: string): FundingRow[] {
  const path = fundingFilePathFor(symbol);
  if (!existsSync(path)) {
    throw new Error(
      `runAgenticReplay: perp symbol "${symbol}" has no cached funding history at ${path} — ` +
        `fetch it first: node test/backtest/fetch-data.mjs ${symbol} <timeframe> <bars> --funding`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FundingRow[];
}

// ── Candle / indicator construction (mirrors agentic.strategy.ts's buildContext) ─────────────────

function toCandleEvent(
  bar: Bar,
  index: number,
  symbol: SymbolId,
  venue: ReturnType<typeof venueId>,
  interval: CandleInterval,
  intervalMs: number,
): CandleEvent {
  const openTime = epochMs(bar[0]!);
  return {
    kind: 'CANDLE',
    venue,
    symbol,
    channel: `candle:${interval}`,
    seq: BigInt(index + 1),
    eventTime: openTime,
    ingestTime: openTime,
    interval,
    openTime,
    closeTime: epochMs(bar[0]! + intervalMs),
    open: price(new Decimal(bar[1]!)),
    high: price(new Decimal(bar[2]!)),
    low: price(new Decimal(bar[3]!)),
    close: price(new Decimal(bar[4]!)),
    volume: qty(new Decimal(bar[5] ?? 0)),
    closed: true,
  };
}

function computeIndicators(
  closes: readonly number[],
  highs: readonly number[],
  lows: readonly number[],
): AgentIndicators | null {
  if (closes.length < INDICATOR_WARMUP_CLOSES) return null;
  return {
    lastClose: closes[closes.length - 1]!,
    emaFast: emaFromNumbers(closes, 9),
    emaSlow: emaFromNumbers(closes, 21),
    rsi14: rsiFromNumbers(closes, 14),
    atr14: atrFromNumbers(highs, lows, closes, 14),
    ret1: pctChange(closes, 1),
    ret5: pctChange(closes, 5),
    ret20: pctChange(closes, 20),
  };
}

function buildHtfIndicators(
  candles: readonly CandleEvent[],
  targetMs: number,
  baseIntervalMs: number,
): AgentHtfIndicators | null {
  const factor = targetMs / baseIntervalMs;
  if (!Number.isInteger(factor) || factor < 2) return null;
  const htfCandles = aggregateCandles(candles, factor, baseIntervalMs).filter((c) => c.closed);
  if (htfCandles.length < INDICATOR_WARMUP_CLOSES) return null;
  const closes = htfCandles.map((c) => toIndicatorNumber(c.close));
  return {
    emaFast: emaFromNumbers(closes, 9),
    emaSlow: emaFromNumbers(closes, 21),
    rsi14: rsiFromNumbers(closes, 14),
  };
}

function buildHtfContext(
  candles: readonly CandleEvent[],
  baseIntervalMs: number,
): { readonly h1: AgentHtfIndicators | null; readonly h4: AgentHtfIndicators | null } {
  return {
    h1: buildHtfIndicators(candles, HTF_TARGET_MS.h1, baseIntervalMs),
    h4: buildHtfIndicators(candles, HTF_TARGET_MS.h4, baseIntervalMs),
  };
}

// ── Symbol capabilities (mirrors anthropic-agent-client.ts's capabilitiesFor) ────────────────────

// v3 consolidation spec §4.2: shorts/leverage/maxSizeFraction are a per-symbol VENUE fact, never a
// harness flag — venueForSymbol is the SAME canonical resolution the production client calls, so a
// ':'-settled perp id advertises shorts here exactly as it does live, and a spot id advertises none.
export function capabilitiesForSymbol(symbol: SymbolId, venueFreeCash: string): SymbolCapabilities {
  const venue = venueForSymbol(symbol);
  const isPerp = venue === PERP_VENUE_ID;
  return {
    venue,
    shorts: isPerp,
    leverage: isPerp ? PERP_LEVERAGE_CAP : '1',
    maxSizeFraction: isPerp ? MAX_POSITION_FRACTION_PERP : MAX_POSITION_FRACTION_SPOT,
    venueFreeCash,
  };
}

// ── Model call: request shape mirrors anthropic-agent-client.ts's attemptOnce ────────────────────

// The parsed v3 tool payload — inferred from PRODUCTION's own schema rather than re-declared, so a
// bound or a required-field change there lands here without a second hand-maintained copy.
type TradeDecision = z.infer<ReturnType<typeof tradeDecisionSchema>>;

const envelopeSchema = z.object({
  stop_reason: z.string().optional(),
  content: z
    .array(
      z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

function buildUserContent(
  marketPayloadJson: string,
  playbookContent: string | undefined,
): string | AnthropicTextBlock[] {
  if (!playbookContent) return marketPayloadJson;
  return [
    { type: 'text', text: buildPlaybookBlock(playbookContent), cache_control: EPHEMERAL_1H },
    { type: 'text', text: `\n\n${marketPayloadJson}` },
  ];
}

interface FlooredDecision {
  readonly decision: MappedDecision;
  readonly outcome: AgenticReplayDecisionOutcome;
}

// Production's rejection path (anthropic-agent-client.ts:1435-1462) retains exactly ONE surviving
// economic gate post-2026-07-18: takeProfitPct >= the round-trip fee fraction. This harness's
// edge/RR/stop floor SHAPE below is NOT a re-implementation of a richer prod rejection path — none
// remains — it defaults (minEdgeMultiple '1', minRr '0') to collapse onto that same single gate (see
// the file header's FLOORS note), staying caller-tunable for a deliberate stricter research sweep.
// Also applies the post-parse CAPABILITY check, restricted to the only case this module ever calls the
// model for — opening a fresh position from FLAT (see live-agentic-strategy.ts's header: re-arm/
// scale-in/adjust are out of scope). Every refusal returns a hold AND names itself in `outcome`, so a
// scorecard can tell a chosen hold from a masked one.
function applyFloors(
  raw: TradeDecision,
  caps: SymbolCapabilities,
  minEdgeMultiple: Decimal,
  minRr: Decimal,
  feeFraction: Decimal,
): FlooredDecision {
  const rationale = raw.thesis ?? '(no thesis)';
  if (raw.action === 'hold') return { decision: { action: 'hold', rationale }, outcome: 'hold' };
  if (raw.action === 'close') return { decision: { action: 'close', rationale }, outcome: 'close' };
  if (raw.action === 'adjust') {
    return { decision: { action: 'adjust', rationale }, outcome: 'adjust' };
  }
  if (raw.action === 'open_short' && !caps.shorts) {
    // Same degrade the production client applies (§4.3): a shorts-disabled symbol's 'open_short' is a
    // capability violation — journaled/counted, never executed.
    return {
      decision: {
        action: 'hold',
        rationale: `[capability violation: shorts disabled] ${rationale}`,
      },
      outcome: 'capability_rejected',
    };
  }
  // requireTradeDirectives (anthropic-agent-client.ts) makes all six fields mandatory on an open_*,
  // so a parse that got here has them; the guard is a type narrowing, not a second policy.
  if (
    raw.sizeFraction === undefined ||
    raw.entry === undefined ||
    raw.entryValidityBars === undefined ||
    raw.stopLossPct === undefined ||
    raw.takeProfitPct === undefined ||
    raw.maxHoldBars === undefined
  ) {
    return {
      decision: { action: 'hold', rationale: `[directives missing] ${rationale}` },
      outcome: 'schema_rejected',
    };
  }

  const edgeFloor = minEdgeMultiple.mul(feeFraction);
  const stopLossPct = new Decimal(String(raw.stopLossPct));
  const takeProfitPct = new Decimal(String(raw.takeProfitPct));

  let rejectionTag: string | undefined;
  if (takeProfitPct.lt(edgeFloor)) rejectionTag = 'edge below floor';
  else if (stopLossPct.lt(feeFraction)) rejectionTag = 'stop below fee floor';
  else if (takeProfitPct.div(stopLossPct).lt(minRr)) rejectionTag = 'RR below floor';
  if (rejectionTag) {
    return {
      decision: {
        action: 'hold',
        rationale: `[directives rejected: ${rejectionTag}] ${rationale}`,
      },
      outcome: 'floor_rejected',
    };
  }

  // Pct/fraction fields cross into AgentDirectives as exact STRINGS (money-safe path, CLAUDE.md rule
  // 1) — String() of the wire number, never parseFloat/Number, same as the production mapping.
  const directives: AgentDirectives = {
    sizeFraction: String(raw.sizeFraction),
    stopLossPct: String(raw.stopLossPct),
    takeProfitPct: String(raw.takeProfitPct),
    entryOffsetBps: raw.entry.offsetBps,
    entryValidityBars: raw.entryValidityBars,
    maxHoldBars: raw.maxHoldBars,
    entryStyle: raw.entry.style,
    direction: raw.action === 'open_short' ? 'short' : 'long',
    ...(raw.thesis !== undefined ? { thesis: raw.thesis } : {}),
  };
  return { decision: { action: raw.action, rationale, directives }, outcome: 'accepted' };
}

interface CallModelResult {
  readonly decision: MappedDecision;
  readonly costUsd: Decimal;
  readonly outcome: AgenticReplayDecisionOutcome;
}

async function callModel(params: {
  readonly fetchFn: typeof fetch;
  readonly route: ModelRoute;
  readonly model: string;
  readonly maxTokens: number;
  readonly systemPrompt: string;
  readonly tool: ReturnType<typeof buildTradeTool>;
  readonly caps: SymbolCapabilities;
  readonly userContent: string | AnthropicTextBlock[];
  readonly priceUsage: (usage: CallUsage | undefined) => Decimal;
  readonly minEdgeMultiple: Decimal;
  readonly minRr: Decimal;
  readonly feeFraction: Decimal;
}): Promise<CallModelResult> {
  const failed = (rationale: string, costUsd: Decimal, outcome: AgenticReplayDecisionOutcome) => ({
    decision: { action: 'hold' as const, rationale },
    costUsd,
    outcome,
  });
  let res: Response;
  try {
    res = await params.fetchFn(`${params.route.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': params.route.apiKey!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        // A non-default (third-party Anthropic-compat) host may expect Bearer instead of x-api-key;
        // sending both is harmless and removes a whole failure branch — the same header rule the
        // eval lane's routed calls use.
        ...(!params.route.isDefaultBase ? { authorization: `Bearer ${params.route.apiKey!}` } : {}),
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens,
        system: [{ type: 'text', text: params.systemPrompt, cache_control: EPHEMERAL_1H }],
        messages: [{ role: 'user', content: params.userContent }],
        tools: [params.tool],
        tool_choice: { type: 'tool', name: params.tool.name },
        // Same rationale as anthropic-agent-client.ts's attemptOnce: structured tool-use has no use
        // for (billed) adaptive thinking.
        thinking: { type: 'disabled' },
      }),
    });
  } catch {
    return failed('error: model call threw (transport)', new Decimal(0), 'call_failed');
  }
  if (!res.ok) {
    return failed(`error: model call returned http ${res.status}`, new Decimal(0), 'call_failed');
  }

  const body: unknown = await res.json();
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) {
    return failed('error: unparseable response envelope', new Decimal(0), 'call_failed');
  }
  const usage: CallUsage | undefined = envelope.data.usage
    ? {
        inputTokens: envelope.data.usage.input_tokens,
        outputTokens: envelope.data.usage.output_tokens,
        cacheReadInputTokens: envelope.data.usage.cache_read_input_tokens,
        cacheCreationInputTokens: envelope.data.usage.cache_creation_input_tokens,
      }
    : undefined;
  const costUsd = params.priceUsage(usage);

  const toolBlock = envelope.data.content?.find(
    (b) => b.type === 'tool_use' && b.name === params.tool.name,
  );
  // Fix 4 (XA4 parity, anthropic-agent-client.ts:707-722): a max_tokens stop with NO tool_use block at
  // all is a TRUNCATED decision — the model ran out of output budget (thinking + tool JSON) before
  // emitting the call — not a clean schema failure. Counted separately BEFORE the schema parse below,
  // which would otherwise fold it into schema_rejected (a missing block still parses `undefined`
  // against the schema and fails the same way a structurally-invalid input does) and collapse exactly
  // the distinction the 2026-07-22 contract-hardening pass exists to preserve. A tool_use block that IS
  // present but stop_reason is max_tokens falls through to the ordinary schema check below, same as
  // production — a partial-but-parseable block is still a legitimate parse attempt, not a truncation.
  if (!toolBlock && envelope.data.stop_reason === 'max_tokens') {
    return failed(
      `truncated: max_tokens stop before a ${params.tool.name} tool_use block ` +
        `(output_tokens=${usage?.outputTokens ?? 'unknown'})`,
      costUsd,
      'truncated',
    );
  }
  // A missing tool_use block (any other stop_reason) parses `undefined` against the schema and fails
  // the same way a structurally-invalid input does — one rejection path, not two. sizeFractionMax is
  // THIS symbol's own cap (Number() at the schema boundary, the same coercion the production/eval call
  // sites use).
  const parsed = tradeDecisionSchema(Number(params.caps.maxSizeFraction)).safeParse(
    toolBlock?.input,
  );
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const summary = firstIssue
      ? `${firstIssue.path.map(String).join('.') || '(root)'}: ${firstIssue.message}`
      : 'unknown schema issue';
    // Self-describing, exactly like production's schemaRejectedRationale — a masked degrade is
    // undiagnosable from the aggregate alone.
    return failed(`schema_rejected: ${summary}`, costUsd, 'schema_rejected');
  }

  const floored = applyFloors(
    parsed.data,
    params.caps,
    params.minEdgeMultiple,
    params.minRr,
    params.feeFraction,
  );
  return { decision: floored.decision, costUsd, outcome: floored.outcome };
}

// ── Walk-forward segmentation (honest OOS by construction — see file header) ─────────────────────

// The notional a closed trip's return is measured against: its OPENING leg. walkRoundTrips names its
// VWAPs by FILL SIDE (entryVwap is the BUY-side VWAP), which coincides with the opening leg only for
// a LONG — a SHORT opens on the SELL, so its opening notional is soldQty x exitVwap. Reading
// entryVwap for a short would divide by the CLOSING notional instead, biasing every short's bps by
// exactly its own return.
function openingNotional(cycle: ClosedRoundTrip, direction: PositionDirection): Decimal | null {
  if (direction === 'SHORT') {
    return cycle.exitVwap !== null && cycle.soldQty.gt(0)
      ? cycle.exitVwap.mul(cycle.soldQty)
      : null;
  }
  return cycle.entryVwap !== null && cycle.boughtQty.gt(0)
    ? cycle.entryVwap.mul(cycle.boughtQty)
    : null;
}

function computeSegmentStats(
  cycles: readonly ClosedRoundTrip[],
  directions: readonly PositionDirection[],
  entryBarIndex: readonly number[],
  exitBarIndex: readonly number[],
  equityCurve: readonly Decimal[],
  startingCash: Decimal,
  fromIdx: number,
  toIdx: number,
): AgenticReplaySegmentStats {
  const netBpsList: Decimal[] = [];
  let wins = 0;
  let holdSum = 0;
  let n = 0;
  for (let k = 0; k < cycles.length; k++) {
    const entryIdx = entryBarIndex[k]!;
    if (entryIdx < fromIdx || entryIdx >= toIdx) continue;
    const c = cycles[k]!;
    const net = c.realizedPnl.minus(c.feesQuote);
    const entryNotional = openingNotional(c, directions[k] ?? 'LONG');
    if (entryNotional !== null && entryNotional.gt(0)) {
      netBpsList.push(net.div(entryNotional).mul(10_000));
    }
    if (net.gt(0)) wins += 1;
    holdSum += exitBarIndex[k]! - entryIdx;
    n += 1;
  }
  const meanNetBps =
    netBpsList.length > 0
      ? netBpsList.reduce((a, b) => a.plus(b), new Decimal(0)).div(netBpsList.length)
      : null;

  let peak = equityCurve[fromIdx] ?? startingCash;
  let maxDd = new Decimal(0);
  const end = Math.min(toIdx, equityCurve.length);
  for (let i = fromIdx; i < end; i++) {
    const eq = equityCurve[i]!;
    if (eq.gt(peak)) peak = eq;
    const dd = peak.gt(0) ? peak.minus(eq).div(peak).mul(100) : new Decimal(0);
    if (dd.gt(maxDd)) maxDd = dd;
  }

  const sign: AgenticReplaySegmentStats['sign'] =
    meanNetBps === null
      ? 'n/a'
      : meanNetBps.gt(0)
        ? 'positive'
        : meanNetBps.lt(0)
          ? 'negative'
          : 'flat';

  return {
    fromBarIndex: fromIdx,
    toBarIndex: toIdx,
    roundTrips: n,
    netBpsPerRoundTrip: meanNetBps !== null ? meanNetBps.toFixed(2) : null,
    winRate: n > 0 ? wins / n : null,
    meanHoldBars: n > 0 ? holdSum / n : null,
    maxDrawdownPct: maxDd.toFixed(2),
    sign,
  };
}

// Long-vs-short breakdown over CLOSED trips. `netPnlQuote` is exact (never rounded) — this is the
// number a two-sided lane's whole case rests on, so it must not be a display approximation.
function computeDirectionStats(
  cycles: readonly ClosedRoundTrip[],
  directions: readonly PositionDirection[],
  want: PositionDirection,
): AgenticReplayDirectionStats {
  let n = 0;
  let wins = 0;
  let net = new Decimal(0);
  for (let k = 0; k < cycles.length; k++) {
    if ((directions[k] ?? 'LONG') !== want) continue;
    const c = cycles[k]!;
    const tripNet = c.realizedPnl.minus(c.feesQuote);
    net = net.plus(tripNet);
    if (tripNet.gt(0)) wins += 1;
    n += 1;
  }
  return { roundTrips: n, winRate: n > 0 ? wins / n : null, netPnlQuote: net.toFixed() };
}

// Fix 3: the model's own takeProfitPct, applied to this trip's ACTUAL average entry — the same price
// arithmetic evaluatePlan uses internally to DECIDE the exit (plan-executor.ts's stopPrice/
// takeProfitPrice formula, entry x (1±pct), mirrored by direction), re-derived here only because
// PRICING every fill is this module's own job, not live-agentic-strategy.ts's (see file header's
// ORCHESTRATION SPLIT) — this computes the price the trigger already implies, it does not
// re-implement the trigger DECISION itself (re-check both on any drift in plan-executor.ts).
function takeProfitFillPrice(
  entry: Decimal,
  directives: AgentDirectives,
  side: PositionDirection,
): Decimal {
  const pct = new Decimal(directives.takeProfitPct);
  return side === 'SHORT'
    ? entry.mul(new Decimal(1).minus(pct))
    : entry.mul(new Decimal(1).plus(pct));
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runAgenticReplay(opts: AgenticReplayOpts): Promise<AgenticReplayResult> {
  const bars = opts.bars;
  if (bars.length === 0) throw new Error('runAgenticReplay: no bars supplied');
  const firstBarTs = bars[0]?.[0];
  if (firstBarTs === undefined) throw new Error('runAgenticReplay: first bar has no timestamp');
  if (firstBarTs < EARLIEST_ALLOWED_MS) {
    throw new Error(
      `runAgenticReplay: first bar (${new Date(firstBarTs).toISOString()}) precedes the training-cutoff floor ${EARLIEST_ALLOWED_ISO} — refusing (memorization confound)`,
    );
  }

  const symbol = symbolId(opts.symbol);
  const derivedVenue = venueForSymbol(symbol);
  const venue = opts.venue !== undefined ? venueId(opts.venue) : derivedVenue;
  const sId = strategyId('backtest-agentic');
  const intervalMs = INTERVAL_MS[opts.interval];
  // FUNDING (see file header's FUNDING note): a spot symbol carries no funding by definition —
  // fundingRows stays [] and every accrual branch below is a zero-iteration no-op, so a spot run stays
  // byte-identical to pre-fix behaviour. A perp symbol REFUSES loudly (loadFundingRowsFromDisk throws)
  // when neither an injected override nor an on-disk cache exists, rather than silently trading at zero
  // funding. Sorted defensively by timestamp — the accrual cursor below assumes ascending order, and
  // the cached file is written that way, but an injected test fixture should not have to promise it.
  const isPerp = derivedVenue === PERP_VENUE_ID;
  const fundingRows: readonly FundingRow[] = isPerp
    ? [...(opts.fundingRows ?? loadFundingRowsFromDisk(opts.symbol))].sort(
        (a, b) => a.timestamp - b.timestamp,
      )
    : [];
  const fetchFn = opts.fetchFn ?? fetch;
  const env = opts.env ?? process.env;
  const maxUsd = new Decimal(opts.maxUsd);
  const equityBase = new Decimal(opts.equityBase ?? '1000');
  const makerBps = new Decimal(opts.makerBps ?? '10');
  const takerBps = new Decimal(opts.takerBps ?? '10');
  const settlementFeeBps = new Decimal(opts.settlementFeeBps ?? '10');
  const feeFraction = makerBps.plus(takerBps).div(10_000);
  // Defaults collapse onto production's one surviving economic gate — see AgenticReplayOpts' own
  // comments and the file header's FLOORS note.
  const minEdgeMultiple = new Decimal(opts.minEdgeMultiple ?? '1');
  const minRr = new Decimal(opts.minRr ?? '0');
  const maxTokens = opts.maxTokens ?? 4096;
  const budget: LiveAgenticBudget = { maxDecisions: opts.maxDecisions ?? 1_000_000 };
  const segCountOpt = Math.max(1, opts.segments ?? 3);

  // Routing/pricing: parsed ONCE per run (a malformed knob must fail before the first paid call, not
  // on some later bar), then reused for every call.
  const routes = parseModelRoutes(opts.modelRoutesJson, 'BACKTEST_AGENTIC_MODEL_ROUTES_JSON');
  const route = resolveRouteFrom(opts.model, routes, {
    env,
    fallbackApiKey: opts.apiKey,
  });
  if (!route.apiKey) {
    const envName = apiKeyEnvNameFor(opts.model, routes);
    throw new Error(
      `runAgenticReplay: no API key resolved for model "${opts.model}" — ` +
        (envName !== null
          ? `its route names apiKeyEnv "${envName}"; export that variable`
          : 'pass opts.apiKey (the runner threads ANTHROPIC_API_KEY into it)'),
    );
  }
  const tokenPrices = parseTokenPriceOverrides(
    opts.tokenPricesJson,
    'BACKTEST_AGENTIC_TOKEN_PRICES_JSON',
  );
  const rate = resolveRate(opts.model, tokenPrices);
  const priceUsage = (usage: CallUsage | undefined): Decimal =>
    usage ? callCostUsd(usage, rate) : new Decimal(0);

  const constraints = {
    tickSize: price('0.01'),
    lotStep: qty('0.00001'),
    minNotional: price('5'),
  };
  const tradingProfile: AgentTradingProfile = {
    makerBps: makerBps.toFixed(),
    takerBps: takerBps.toFixed(),
    baseNotional: equityBase.toFixed(),
    maxOrderNotional: equityBase.mul(4).toFixed(),
    constraints,
  };
  const caps = capabilitiesForSymbol(symbol, opts.venueFreeCash ?? equityBase.toFixed());
  // Production's own v3 prompt + tool, built once per run: every feed flag stays off (the fair-proxy
  // payload attaches none of those blocks), so the prompt documents exactly what the payload carries.
  const systemPrompt = buildSystemPrompt(tradingProfile);
  // 2026-07-30: capability-free tool (see buildTradeTool's own comment) — `caps` still reaches the
  // replayed model through the payload's capabilities block, same channel as live.
  const tool = buildTradeTool();

  const fallback: BarStrategy = { decide: () => ({ type: 'hold' }) };
  const strategy = new LiveAgenticStrategy(undefined, budget, fallback);

  const candles: CandleEvent[] = [];
  let pos: PositionState = FLAT;
  const fills: RoundTripFill[] = [];
  const entryBarIndexPerTrip: number[] = [];
  const exitBarIndexPerTrip: number[] = [];
  const directionPerTrip: PositionDirection[] = [];
  const equityCurve: Decimal[] = [];
  const startingCash = new Decimal('5000');
  let spendUsd = new Decimal(0);
  let decisionsRequested = 0;
  let aborted = false;
  let currentEntryBarIndex: number | null = null;
  let currentTripDirection: PositionDirection = 'LONG';
  const exitReasonCounts = { stop: 0, take_profit: 0, max_hold: 0 };
  // FUNDING accrual state (see file header's FUNDING note). fundingCursor is fast-forwarded past every
  // row at-or-before firstBarTs — a pure perf skip of history that predates the walk (nothing is ever
  // open before bar 0, so those rows could never have accrued regardless).
  let fundingCursor = 0;
  while (
    fundingCursor < fundingRows.length &&
    fundingRows[fundingCursor]!.timestamp <= firstBarTs
  ) {
    fundingCursor++;
  }
  let fundingQuoteTotal = new Decimal(0);
  let fundingLongQuoteTotal = new Decimal(0);
  let fundingShortQuoteTotal = new Decimal(0);
  let fundingLongEvents = 0;
  let fundingShortEvents = 0;
  const decisionOutcomeCounts: Record<AgenticReplayDecisionOutcome, number> = {
    accepted: 0,
    hold: 0,
    close: 0,
    adjust: 0,
    floor_rejected: 0,
    capability_rejected: 0,
    schema_rejected: 0,
    truncated: 0,
    call_failed: 0,
  };

  const stepSize = '0.00001';
  const minQty = new Decimal('0.00001');
  const minNotional = new Decimal('5');
  // splitSymbol, not symbol.split('/')[1] — a perp id ('BTC/USDT:USDT') would otherwise stamp the fee
  // asset as 'USDT:USDT', which walkRoundTrips' own quoteAssetOf ('USDT') would not match, silently
  // flagging every perp fee as unconvertible and dropping it from feesQuote entirely.
  const quoteAsset = splitSymbol(symbol).quote;

  let i = 0;
  for (; i < bars.length; i++) {
    if (spendUsd.gte(maxUsd)) {
      aborted = true;
      break;
    }

    const bar = bars[i]!;
    const candle = toCandleEvent(bar, i, symbol, venue, opts.interval, intervalMs);
    candles.push(candle);

    const closesNum = candles.map((c) => toIndicatorNumber(c.close));
    const highsNum = candles.map((c) => toIndicatorNumber(c.high));
    const lowsNum = candles.map((c) => toIndicatorNumber(c.low));
    const closesStr = candles.map((c) => c.close.toFixed());
    const highsStr = candles.map((c) => c.high.toFixed());
    const lowsStr = candles.map((c) => c.low.toFixed());

    const needsDecision = pos.signedQty.isZero() && !strategy.hasActivePlan;

    let resolved: MappedDecision | undefined;
    if (needsDecision && strategy.decisionsUsed < budget.maxDecisions) {
      decisionsRequested += 1;
      const indicators = computeIndicators(closesNum, highsNum, lowsNum);
      const htf = buildHtfContext(candles, intervalMs);
      const input: AgentDecisionInput = {
        strategyId: sId,
        trigger: { kind: 'candle', event: candle },
        snapshot: {
          eventTime: candle.eventTime,
          candles: new Map([[symbol, candles]]),
          // Fair-proxy configuration — no ticker/book/derivatives ever attached (see file header).
          tickers: new Map(),
          books: new Map(),
          execReports: [],
          portfolio: { strategyId: sId, positions: new Map(), openOrders: [] },
        },
        context: {
          indicators,
          // The model is only ever consulted while FLAT with no active plan (see the header split
          // with live-agentic-strategy.ts) — an open-position summary would never be rendered.
          position: FLAT_POSITION_SUMMARY,
          recentDecisions: [],
          htf,
        },
      };
      const marketPayloadJson = buildMarketPayload(input, { constraints, capabilities: caps });
      const userContent = buildUserContent(marketPayloadJson, opts.playbookContent);
      const { decision, costUsd, outcome } = await callModel({
        fetchFn,
        route,
        model: opts.model,
        maxTokens,
        systemPrompt,
        tool,
        caps,
        userContent,
        priceUsage,
        minEdgeMultiple,
        minRr,
        feeFraction,
      });
      spendUsd = spendUsd.plus(costUsd);
      decisionOutcomeCounts[outcome] += 1;
      resolved = decision;
      // Paces a rate-limited routed endpoint (a per-model callDelayMs); 0 on the default route, so
      // an offline scripted-fetch run never touches a timer.
      if (route.callDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, route.callDelayMs));
      }
    }

    // Snapshotted BEFORE decide(): a successful exit clears the strategy's plan synchronously inside
    // that same call (LiveAgenticStrategy.decideManagingPosition sets `this.plan = null` before
    // returning), so the directive set that GOVERNED an exiting bar would otherwise be gone by the
    // time this loop could inspect it — used ONLY by the exit branch below (Fix 3). The entry branch
    // (Fix 1) deliberately reads a FRESH post-decide value instead: a taker entry arms AND fills its
    // plan inside the SAME decide() call, so this pre-decide snapshot is still null on that bar (no
    // plan exists yet at the top of it) and would wrongly skip every taker entry's sizing.
    const preDecidePlanDirectives = strategy.activePlanDirectives;

    const action = strategy.decide(
      {
        closes: closesStr,
        highs: highsStr,
        lows: lowsStr,
        nextOpen: null, // unused — this fill model is priced by THIS loop, not next-bar-open
        markPrice: candle.close.toFixed(),
        fundingRate: null,
        position: pos,
        barIndex: i,
      },
      resolved,
    );

    if (action.type === 'enter') {
      const entryPriceStr = strategy.pendingEntryPrice;
      // Fix 1: entryNotional = equityBase x directives.sizeFraction — see AgenticReplayOpts.equityBase
      // for the full rationale. Read POST-decide (never clones/nulls on an entry — only an exit clears
      // the plan) so both the maker case (plan armed on an earlier bar, filled on this one) and the
      // taker case (plan armed AND filled on this SAME decide() call) see the directives that just
      // armed it. Guaranteed non-null here in practice (an 'enter' action only ever arises from a plan
      // armed by applyFloors' own full-directive-set narrowing), but the null check is kept as a
      // defensive skip rather than a throw — consistent with this loop's other skip-only guards below
      // (min qty/notional) rather than aborting a multi-hour paid run over an unreachable branch.
      const enteringPlanDirectives = strategy.activePlanDirectives;
      if (entryPriceStr !== null && enteringPlanDirectives !== null) {
        const fillPrice = new Decimal(entryPriceStr);
        const entryNotional = equityBase.mul(new Decimal(enteringPlanDirectives.sizeFraction));
        const rawQty = entryNotional.div(fillPrice);
        const q = roundToStep(rawQty, stepSize, 'down');
        if (q.gt(0) && !(q.lt(minQty) || q.mul(fillPrice).lt(minNotional))) {
          // A SHORT opens by SELLING — applyFillToPosition already carries signed positions, so the
          // whole short round trip runs through the same average-cost/realized-PnL domain code a long
          // does, with no short-specific settlement branch anywhere.
          const side = action.side === 'SHORT' ? 'SELL' : 'BUY';
          const feeQuote = takerFeeQuote(fillPrice, q, settlementFeeBps);
          pos = applyFillToPosition(pos, side, q, fillPrice, feeQuote);
          fills.push({
            strategyId: String(sId),
            symbol: opts.symbol,
            side,
            qty: q.toFixed(),
            price: fillPrice.toFixed(),
            fee: feeQuote.toFixed(),
            feeAsset: quoteAsset,
            executedAt: bar[0]!,
          });
          currentEntryBarIndex = i;
          currentTripDirection = action.side;
        }
      }
    } else if (action.type === 'exit' && !pos.signedQty.isZero()) {
      // Fix 3 (2026-07-22 fidelity pass): a take-profit exit fills at the DIRECTIVE's own
      // takeProfitPrice (entry x (1+pct) long / entry x (1-pct) short), never at candle.close.
      // evaluatePlan fires TP on a close-triggered check (close >= takeProfitPrice long / close <=
      // ... short — plan-executor.ts), so close is always at least as favourable as takeProfitPrice by
      // the time this branch runs; filling at close therefore books the OVERSHOOT as free edge (repo's
      // own fixture below: entry 99.9, TP 102.897, close 103 -> close-fill books gross +31,
      // TP-price-fill books gross +29.97 — ~10.3bps phantom edge on this one trip, asymmetric across
      // models since a tight, frequently-overshot TP harvests more of it). Production RESTS a limit TP
      // at the venue (AGENTIC_VENUE_TP=true, .env.app:151), so the real fill is CAPPED at
      // takeProfitPrice — filling here at that same price is the PESSIMISTIC (not optimistic) side of
      // the gap relative to close, matching that venue behaviour. Stop and max-hold exits keep filling
      // at the triggering bar's own close (see file header's FILL MODEL note) — a stop fill AT
      // stopPrice would be the OPTIMISTIC side of the same gap, since evaluatePlan's stop check is
      // close-triggered too. `preDecidePlanDirectives` unexpectedly null here is a fail-OPEN fallback
      // to the pre-fix close-fill (never worse than the status quo this fix replaces) rather than a
      // thrown abort — this is a measurement-fidelity gate, not a safety gate (code-hygiene's failure-
      // direction rule).
      const fillPrice =
        action.reason === 'take_profit' && preDecidePlanDirectives !== null
          ? takeProfitFillPrice(
              pos.avgEntry,
              preDecidePlanDirectives,
              pos.signedQty.gt(0) ? 'LONG' : 'SHORT',
            )
          : candle.close;
      const q = pos.signedQty.abs();
      // Close on the OPPOSITE side of whatever is open — BUY-to-cover a short, SELL a long.
      const side = pos.signedQty.gt(0) ? 'SELL' : 'BUY';
      const feeQuote = takerFeeQuote(fillPrice, q, settlementFeeBps);
      pos = applyFillToPosition(pos, side, q, fillPrice, feeQuote);
      fills.push({
        strategyId: String(sId),
        symbol: opts.symbol,
        side,
        qty: q.toFixed(),
        price: fillPrice.toFixed(),
        fee: feeQuote.toFixed(),
        feeAsset: quoteAsset,
        executedAt: bar[0]!,
      });
      if (currentEntryBarIndex !== null) {
        entryBarIndexPerTrip.push(currentEntryBarIndex);
        exitBarIndexPerTrip.push(i);
        directionPerTrip.push(currentTripDirection);
        currentEntryBarIndex = null;
      }
      if (
        action.reason === 'stop' ||
        action.reason === 'take_profit' ||
        action.reason === 'max_hold'
      ) {
        exitReasonCounts[action.reason] += 1;
      }
    }

    // FUNDING (see file header's FUNDING note): accrue every cached row at-or-before THIS bar's own
    // close, against whatever position survived the fill handling above — mirrors harness.ts's own
    // "funding settles after any fill this bar" convention. Timestamps come STRICTLY from fundingRows
    // itself (never an invented per-bar schedule), so a bar interval coarser than the funding grid
    // (e.g. 4h bars over Binance's 8h grid) correctly accrues more than one event on a straddling bar,
    // and fundingRows is always [] for a spot symbol, making this a zero-iteration no-op there.
    const barCloseTs = bar[0]! + intervalMs;
    while (
      fundingCursor < fundingRows.length &&
      fundingRows[fundingCursor]!.timestamp <= barCloseTs
    ) {
      const row = fundingRows[fundingCursor]!;
      fundingCursor++;
      if (pos.signedQty.isZero()) continue; // flat at accrual time -> nothing settles
      // fundingPayment's sign IS the PnL contribution (test/backtest/funding.ts): negative when the
      // position holder PAYS (a long under a positive rate), positive when they RECEIVE (a short under
      // a positive rate, or either side under a negative one) — folded into pos.realizedPnl exactly
      // like harness.ts does, so the equity curve/drawdown reflect it too.
      const rate = new Decimal(row.fundingRate);
      const payment = fundingPayment(pos.signedQty, candle.close, rate);
      fundingQuoteTotal = fundingQuoteTotal.plus(payment);
      if (pos.signedQty.gt(0)) {
        fundingLongQuoteTotal = fundingLongQuoteTotal.plus(payment);
        fundingLongEvents += 1;
      } else {
        fundingShortQuoteTotal = fundingShortQuoteTotal.plus(payment);
        fundingShortEvents += 1;
      }
      pos = { ...pos, realizedPnl: pos.realizedPnl.plus(payment) };
    }

    // signedQty is SIGNED, so this expression is already correct for a short: a negative qty times a
    // negative (close − avgEntry) move is a positive unrealized PnL. No direction branch needed.
    const unreal = pos.signedQty.mul(candle.close.minus(pos.avgEntry));
    equityCurve.push(startingCash.plus(pos.realizedPnl).plus(unreal));
  }
  const barsUsed = i;

  // Single-position discipline (never more than one open cycle at a time — see
  // live-agentic-strategy.ts's header: no scale-in, one plan at a time) guarantees walkRoundTrips'
  // cycles come back in the SAME order as entryBarIndexPerTrip/exitBarIndexPerTrip/directionPerTrip
  // were pushed (one open-then-close pair per trip, always fully closing before the next opens), so a
  // positional zip is safe. The cycle-closure rule itself is direction-agnostic — it closes on
  // |signedQty| x price dropping below dust, which a SELL-then-BUY short satisfies exactly as a
  // BUY-then-SELL long does.
  const { cycles } = walkRoundTrips(fills, new Decimal('0.01'));

  const segments: AgenticReplaySegmentStats[] = [];
  if (barsUsed > 0) {
    const chunk = Math.max(1, Math.floor(barsUsed / segCountOpt));
    for (let k = 0; k < segCountOpt; k++) {
      const fromIdx = k * chunk;
      if (fromIdx >= barsUsed) break;
      const toIdx = k === segCountOpt - 1 ? barsUsed : Math.min(barsUsed, (k + 1) * chunk);
      segments.push(
        computeSegmentStats(
          cycles,
          directionPerTrip,
          entryBarIndexPerTrip,
          exitBarIndexPerTrip,
          equityCurve,
          startingCash,
          fromIdx,
          toIdx,
        ),
      );
    }
  }
  const totals = computeSegmentStats(
    cycles,
    directionPerTrip,
    entryBarIndexPerTrip,
    exitBarIndexPerTrip,
    equityCurve,
    startingCash,
    0,
    barsUsed,
  );

  const realizedQuote = cycles.reduce((a, c) => a.plus(c.realizedPnl), new Decimal(0));
  const feesQuote = cycles.reduce((a, c) => a.plus(c.feesQuote), new Decimal(0));
  // Funding is its OWN line item (CLAUDE.md rule 1 — never silently mixed into feesQuote) but IS folded
  // into netQuote/netOfLlmSpendQuote here: those are the two figures this fix must make genuinely net
  // of funding (see the file header's FUNDING note). fundingQuoteTotal is always '0' for a spot symbol.
  const netQuote = realizedQuote.minus(feesQuote).plus(fundingQuoteTotal);

  return {
    symbol: opts.symbol,
    interval: opts.interval,
    model: opts.model,
    shortsEnabled: caps.shorts,
    fromTs: firstBarTs,
    toTs: bars[Math.max(0, barsUsed - 1)]?.[0] ?? firstBarTs,
    barsSupplied: bars.length,
    barsUsed,
    decisionsRequested,
    decisionsAccepted: decisionOutcomeCounts.accepted,
    decisionOutcomeCounts,
    spendUsd: spendUsd.toFixed(6),
    maxUsd: maxUsd.toFixed(6),
    aborted,
    abortReason: aborted ? 'ABORTED_BUDGET' : null,
    openPositionAtEnd: !pos.signedQty.isZero(),
    exitReasonCounts,
    pnl: {
      realizedQuote: realizedQuote.toFixed(),
      feesQuote: feesQuote.toFixed(),
      fundingQuote: fundingQuoteTotal.toFixed(),
      netQuote: netQuote.toFixed(),
      llmSpendUsd: spendUsd.toFixed(),
      netOfLlmSpendQuote: netQuote.minus(spendUsd).toFixed(),
      long: computeDirectionStats(cycles, directionPerTrip, 'LONG'),
      short: computeDirectionStats(cycles, directionPerTrip, 'SHORT'),
      fundingLong: { events: fundingLongEvents, netQuote: fundingLongQuoteTotal.toFixed() },
      fundingShort: { events: fundingShortEvents, netQuote: fundingShortQuoteTotal.toFixed() },
    },
    segments,
    totals,
    sizingModel: { kind: 'sizeFraction-of-equityBase', equityBaseQuote: equityBase.toFixed() },
    fairProxyNote: FAIR_PROXY_NOTE,
  };
}
