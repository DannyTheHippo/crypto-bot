import type { Signal } from '../domain/types/signal';
import type { StrategyId } from '../domain/types/ids';
import type { Strategy } from '../domain/strategy/strategy';

// Signal journaling sink (§8 decision trail). The SignalSink records every signal it routes, tagged
// with the gateway outcome and resulting intentId (if any). The composition root provides a DB-backed
// SignalJournalAdapter when the persistence path is active, else the token resolves to undefined and
// the @Optional consumer simply skips journaling. record is fire-and-forget at the adapter — an
// analysis artifact, not a safety interlock.
export const SIGNAL_JOURNAL = Symbol('SIGNAL_JOURNAL');
export interface SignalJournalPort {
  record(signal: Signal, outcome: string, intentId?: string): void;
}

// ── Registry port ─────────────────────────────────────────────────────────────

export type DrainPolicy =
  | 'CANCEL_OPEN_AND_FLATTEN'
  | 'CANCEL_OPEN_KEEP_POSITION'
  | 'MANAGE_TO_CLOSE';

export interface StrategyState {
  readonly id: StrategyId;
  readonly lifecycle: StrategyLifecycle;
}

export type StrategyLifecycle =
  | 'LOADING'
  | 'WARMUP'
  | 'ACTIVE'
  | 'DRAINING'
  | 'HALTED'
  | 'UNLOADED';

export interface StrategyRegistryPort {
  register(type: string, factory: (id: StrategyId, params: unknown) => Strategy): void;
  enable(id: StrategyId, type: string, params: unknown): void;
  disable(id: StrategyId, drain?: DrainPolicy): void;
  states(): readonly StrategyState[];
}

// ── Host port ─────────────────────────────────────────────────────────────────

export interface StrategyHostPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  signals(): AsyncIterable<Signal>;
}

// ── Signal sink port ──────────────────────────────────────────────────────────
//
// Written by the host for every signal that is NOT discarded during WARMUP.
// The no-op default is provided by StrategyModule; app-level wiring replaces it
// with the real persistence implementation in a later phase.

export interface SignalSinkPort {
  recordSignal(s: Signal): void | Promise<void>;
}

export const STRATEGY_REGISTRY = Symbol('STRATEGY_REGISTRY');
export const STRATEGY_HOST = Symbol('STRATEGY_HOST');
export const SIGNAL_SINK = Symbol('SIGNAL_SINK');
