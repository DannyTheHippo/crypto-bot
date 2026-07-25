import type { Qty } from './money';
import type { EpochMs } from './ids';
import type { OrderIntent } from './order-intent';

// ── RiskReason ───────────────────────────────────────────────────────────────

export type RiskReason =
  | 'KILL_SWITCH'
  | 'MODE_MISMATCH'
  | 'LIMITS_INCOMPLETE'
  | 'STALE_DATA'
  | 'PRICE_BAND'
  | 'FAT_FINGER'
  | 'EXPIRED'
  | 'REF_DRIFT'
  | 'RATE_LIMIT'
  | 'CROSSING_INTENT'
  | 'POSITION_LIMIT'
  | 'EXPOSURE_LIMIT'
  | 'DAILY_LOSS'
  | 'MAX_DRAWDOWN'
  | 'BELOW_EXCHANGE_MIN'
  | 'REDUCE_ONLY_VIOLATION';

// ── ApprovalProof ────────────────────────────────────────────────────────────

export interface ApprovalProof {
  readonly intentHash: string;
  readonly hmac: string;
  readonly nonce: string;
  readonly approvedAtMs: EpochMs;
  readonly ttlMs: number;
  readonly limitsVersion: string;
  readonly snapshotSeq: bigint;
}

// ── RiskApprovedIntent ───────────────────────────────────────────────────────

// The brand symbol is NOT exported — Execution cannot forge the type.
declare const _riskApproved: unique symbol;

export type RiskApprovedIntent = {
  readonly [_riskApproved]: true;
  readonly intent: OrderIntent;
  readonly proof: ApprovalProof;
};

// ── RiskDecision ─────────────────────────────────────────────────────────────

export type RiskDecision =
  | { readonly verdict: 'APPROVED'; readonly approved: RiskApprovedIntent }
  | {
      readonly verdict: 'RESIZED';
      readonly approved: RiskApprovedIntent;
      readonly originalQty: Qty;
      readonly reasons: readonly RiskReason[];
    }
  | {
      readonly verdict: 'REJECTED';
      readonly intent: OrderIntent;
      readonly reasons: readonly RiskReason[];
    };
