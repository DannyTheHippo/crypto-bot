import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { TradingRuntimeService } from '../../../../src/features/trading/composition/trading-runtime.module';
import { epochMs } from '../../../../src/domain/common/types/ids';
import type { PortfolioSnapshot } from '../../../../src/domain/trading/types/portfolio';

// M1 (2026-07-27): agentic_budget_remaining_usd was observed stuck at 0 with zero LLM calls this
// boot — logPortfolio() previously had no top-level try/catch (unlike every other metrics call site
// in this repo) and computed the gauge value AFTER the portfolio snapshot/logging work, so a throw
// anywhere in that later work silently suppressed the gauge write forever.
//
// TradingRuntimeService's own constructor wires the full app DI graph (~30 collaborators) — it is
// never direct-constructed anywhere in this suite. Object.create bypasses the constructor entirely
// and stubs only the handful of instance fields logPortfolio() itself reads, so this exercises the
// REAL method body without needing every other collaborator.
interface LogPortfolioHarness {
  logPortfolio(): void;
}

function makeHarness(opts: {
  budgetBlock?: () => {
    remainingCallsToday: number;
    remainingTokensToday: number;
    remainingUsdToday: string;
    approxCostPerConsultUsd: string;
  };
  portfolioSnapshot?: () => PortfolioSnapshot;
}): {
  service: LogPortfolioHarness;
  setBudgetRemainingUsd: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const setBudgetRemainingUsd = vi.fn();
  const warn = vi.fn();
  const service = Object.create(TradingRuntimeService.prototype) as Record<string, unknown>;
  service['log'] = { log: () => undefined, warn };
  service['agentBudget'] = {
    budgetBlock:
      opts.budgetBlock ??
      (() => ({
        remainingCallsToday: 10,
        remainingTokensToday: 1000,
        remainingUsdToday: '3',
        approxCostPerConsultUsd: '0',
      })),
  };
  service['agentMetrics'] = { setBudgetRemainingUsd };
  service['portfolio'] = {
    snapshot:
      opts.portfolioSnapshot ??
      (() => {
        throw new Error('collaborator boom');
      }),
  };
  service['config'] = { risk: { equityCap: '1000' } };
  service['macroCalendar'] = [];
  service['clock'] = { now: () => epochMs(1_700_000_000_000) };
  return { service: service as unknown as LogPortfolioHarness, setBudgetRemainingUsd, warn };
}

function emptySnapshot(): PortfolioSnapshot {
  return {
    positions: new Map(),
    balances: new Map(),
    openOrders: [],
    inFlightIntents: [],
    equity: new Decimal(1000),
    unrealized: new Decimal(0),
    startingCash: new Decimal(1000),
    peakEquity: new Decimal(1000),
    sodEquityUtc: new Decimal(1000),
    reconcileStatus: 'CLEAN',
    snapshotSeq: 0n,
  };
}

describe('TradingRuntimeService.logPortfolio (M1)', () => {
  it('still updates the budget gauge when a later collaborator (portfolio.snapshot) throws, and never propagates the throw', () => {
    const { service, setBudgetRemainingUsd, warn } = makeHarness({});

    expect(() => service.logPortfolio()).not.toThrow();

    expect(setBudgetRemainingUsd).toHaveBeenCalledWith(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('logPortfolio failed'));
  });

  it('the gauge write itself never throws into the trading path when budgetBlock() fails, and warns instead', () => {
    const { service, setBudgetRemainingUsd, warn } = makeHarness({
      budgetBlock: () => {
        throw new Error('budget read failed');
      },
      portfolioSnapshot: emptySnapshot,
    });

    expect(() => service.logPortfolio()).not.toThrow();

    expect(setBudgetRemainingUsd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget gauge update failed'));
  });

  it('updates the gauge with the exact remainingUsdToday value on the ordinary (non-throwing) path', () => {
    const { service, setBudgetRemainingUsd, warn } = makeHarness({
      budgetBlock: () => ({
        remainingCallsToday: 5,
        remainingTokensToday: 500,
        remainingUsdToday: '2.5',
        approxCostPerConsultUsd: '0.1',
      }),
      portfolioSnapshot: emptySnapshot,
    });

    expect(() => service.logPortfolio()).not.toThrow();

    expect(setBudgetRemainingUsd).toHaveBeenCalledWith(2.5);
    expect(warn).not.toHaveBeenCalled();
  });
});
