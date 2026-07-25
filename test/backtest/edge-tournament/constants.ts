// Frozen edge-tournament preregistration constants — RESEARCH TOOLING (off production gate).
// Parameters locked 2026-07-24 per research/studies/edge-tournament-preregistration-2026-07-24.md.

/** Disclosed global discovery count for DSR diagnostic (conservative N). */
export const GLOBAL_DISCOVERY_COUNT = 5239;

/** Effective research book — all PnL reported against this notional. */
export const EFFECTIVE_BOOK_USD = '1000';

/** Gross target exposure cap (fraction of effective book). */
export const MAX_GROSS_EXPOSURE_FRACTION = '0.40';

export const TRIAL_IDS = [
  'xsec20-ew',
  'xsec20-volbeta',
  'residual20-volbeta',
  'news1d-asymmetric',
  'funding-dispersion-3d',
  'xsec20-volbeta-macro',
] as const;

export type TrialId = (typeof TRIAL_IDS)[number];

/** Base symbols (no quote/settle suffix) — frozen 16-perp Binance USDM universe. */
export const UNIVERSE_BASE = [
  'BTC',
  'ETH',
  'SOL',
  'ZEC',
  'AAVE',
  'NEAR',
  'HYPE',
  'KAITO',
  'TRUMP',
  'UNI',
  'BCH',
  'XRP',
  'LINK',
  'AVAX',
  'SUI',
  'LTC',
] as const;

export type UniverseBase = (typeof UNIVERSE_BASE)[number];

export function toBinanceUsdmSymbol(base: UniverseBase): string {
  return `${base}/USDT:USDT`;
}

export function toSafeCacheName(ccxtSymbol: string): string {
  return ccxtSymbol.replace(/[/:]/g, '');
}

/** Minimum closed daily observations before a symbol is eligible. */
export const ELIGIBILITY_LOOKBACK_DAYS = 90;

export const RETURN_LOOKBACK_DAYS = 20;
export const VOL_LOOKBACK_DAYS = 20;
export const BETA_LOOKBACK_DAYS = 60;
export const XSEC_REBALANCE_DAYS = 6;
export const XSEC_TOP_N = 2;
export const XSEC_BOTTOM_N = 2;

export const NEWS_Z_LOOKBACK_DAYS = 90;
export const NEWS_Z_SHORT_THRESHOLD = -2;
export const NEWS_Z_LONG_THRESHOLD = 2;
export const NEWS_HOLD_DAYS = 1;

export const FUNDING_STABILITY_SETTLEMENTS = 3;
/** Exit after ~3 calendar days; USDM/Bybit/OKX settle 3×/day ⇒ 9 settlements. */
export const FUNDING_HOLD_DAYS = 9;
export const FUNDING_CARRY_FEE_MULTIPLIER = 2;

export const MACRO_BLACKOUT_BEFORE_MS = 6 * 3_600_000;
export const MACRO_BLACKOUT_AFTER_MS = 2 * 3_600_000;
export const MACRO_REDUCED_EXPOSURE_FRACTION = '0.50';
export const MACRO_REDUCED_DURATION_MS = 48 * 3_600_000;

/** Chronological reporting segments (UTC inclusive start, exclusive end). */
export interface TimeSegment {
  readonly id: 1 | 2 | 3;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
}

export const REPORTING_SEGMENTS: readonly TimeSegment[] = [
  {
    id: 1,
    label: '2023-07-25..2024-07-24',
    startMs: Date.parse('2023-07-25T00:00:00.000Z'),
    endMs: Date.parse('2024-07-25T00:00:00.000Z'),
  },
  {
    id: 2,
    label: '2024-07-25..2025-07-24',
    startMs: Date.parse('2024-07-25T00:00:00.000Z'),
    endMs: Date.parse('2025-07-25T00:00:00.000Z'),
  },
  {
    id: 3,
    label: '2025-07-25..last-closed-daily',
    startMs: Date.parse('2025-07-25T00:00:00.000Z'),
    endMs: Date.parse('2026-07-25T00:00:00.000Z'),
  },
];

export const FUNDING_VENUES = ['binanceusdm', 'bybit', 'okx'] as const;
export type FundingVenue = (typeof FUNDING_VENUES)[number];

/** VIP-0 taker fee per venue (bps, exact strings for money-path adjacency). */
export const VENUE_TAKER_FEE_BPS: Readonly<Record<FundingVenue, string>> = {
  binanceusdm: '5',
  bybit: '5.5',
  okx: '5',
};

/** Directional perp leg costs (demo-equivalent). */
export const DIRECTIONAL_FEE_BPS = '10';
export const DIRECTIONAL_SLIPPAGE_BPS = '5';

/** LLM consult floor per rebalance/event (USD exact string) — modeled accounting only. */
export const LLM_COST_FLOOR_USD = '0.03';

/**
 * Hard cap on *real* LLM API spend per tournament run (owner: 2026-07-24).
 * The six calculators MUST remain LLM-free; this cap exists only if a follow-up
 * probe ever needs live model calls. Modeled LLM_COST_FLOOR_USD is not spend.
 */
export const MAX_TOURNAMENT_REAL_LLM_SPEND_USD = '2';

/** Winner gate thresholds. */
export const WINNER_MIN_CYCLES = 30;
export const WINNER_MAX_DRAWDOWN_FRACTION = '0.10';
export const WINNER_MAX_SYMBOL_PROFIT_SHARE = '0.40';
export const WINNER_MIN_POSITIVE_SEGMENTS = 2;
