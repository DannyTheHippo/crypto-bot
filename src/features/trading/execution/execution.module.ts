import { Module, type Provider } from '@nestjs/common';
import { CLOCK, SystemClock } from '../../../ports/clock';
import { FEED_HEALTH, REAL_FEED_HEALTH, type FeedHealthPort } from '../../../ports/market-data';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import {
  EXECUTION_GATE,
  PORTFOLIO_VIEW,
  EXEC_OUTBOX,
  EXECUTION_STORE,
  EXEC_RUN_CONTEXT,
  PORTFOLIO_CONFIG,
  EXEC_FILTERS,
  EXEC_REPORT_NOTIFY,
  EQUITY_OBSERVER,
  EQUITY_LIMITS,
  RECON_CONFIG,
  INSTANCE_LOCK,
  EXEC_OUTBOX_OVERRIDE,
  EXECUTION_STORE_OVERRIDE,
  INSTANCE_LOCK_OVERRIDE,
  type ExecOutboxPort,
  type ExecutionStorePort,
  type InstanceLockPort,
  type ExecRunContext,
  type PortfolioConfig,
  type ExecFilters,
  type EquityLimits,
  type ReconConfig,
  type EquityObserver,
} from '../../../ports/execution';
import { InMemoryExecOutbox } from './in-memory-outbox';
import { InMemoryExecutionStore } from './in-memory-store';
import { InMemoryInstanceLock } from './in-memory-instance-lock';
import { NonceLedgerService } from './nonce-ledger.service';
import { FeeLedgerService } from './fee-ledger.service';
import { PortfolioStateService } from './portfolio-state.service';
import { EquitySamplerService } from './equity-sampler.service';
import { EquityMonitorService } from './equity-monitor.service';
import { OrderBookService } from './order-book.service';
import {
  FillIngestorService,
  FILLS_COUNTER,
  ORDERS_FILLED_QTY_COUNTER,
  ORDERS_FULLY_FILLED_COUNTER,
  SLIPPAGE_DECISION_HISTOGRAM,
  FEES_PAID_COUNTER,
  ROUND_TRIPS_COUNTER,
  TRADE_PNL_HISTOGRAM,
} from './fill-ingestor.service';
import {
  ExecutionGateService,
  ORDERS_COUNTER,
  ORDERS_REJECTED_COUNTER,
  ORDERS_SUBMITTED_COUNTER,
  ORDERS_SUBMITTED_QTY_COUNTER,
  ORDER_SUBMIT_LATENCY,
} from './execution-gate.service';
import { ExecReportConsumerService } from './exec-report-consumer.service';
import { UnknownResolverService } from './unknown-resolver.service';
import {
  ReconciliationService,
  RECON_MISMATCH_COUNTER,
  RECON_RUNS_COUNTER,
  RECON_LAST_SUCCESS_GAUGE,
} from './reconciliation.service';
import { CrashRecoveryService } from './crash-recovery.service';
import { BootRecoveryService } from './boot-recovery.service';
import { DemoFillPollerService } from './demo-fill-poller.service';

// ExecutionModule owns the OMS edge: the outbox/store, the canonical portfolio, the gate and the
// report consumer. EXCHANGE_PORT is NOT bound here — binding it to a concrete adapter (paper or
// ccxt) is the composition root's job (§1.5: only app.module sees concretions). The gate consumes
// EXCHANGE_PORT from the global scope; RISK_SIGNING_KEY likewise comes from the composition root.
const noopFeedHealth: FeedHealthPort = {
  health: () => 'GAP',
  getRefPrice: () => undefined,
  fetchCandles: () => Promise.resolve([]),
};
const REAL_FEED_HEALTH_OPTIONAL = { token: REAL_FEED_HEALTH, optional: true } as const;
const CONFIG_OPTIONAL = { token: TypedConfigService, optional: true } as const;

// EXEC_RUN_CONTEXT.mode must track the boot config authority (paper/testnet/live) — it stamps the
// run and must agree with the mode the sizer brands intents with. TypedConfigService is @Optional so
// the module-isolation boot specs (no AppConfigModule) keep the paper defaults.
function runContextFrom(config: TypedConfigService | undefined): ExecRunContext {
  if (config === undefined) return { mode: 'paper', runId: 'paper-local', bootId: 'boot-local' };
  const bootId = config.app.bootId;
  return { mode: config.mode.configMode, runId: `run-${bootId}`, bootId };
}
// startingCash is env-tunable (STARTING_CASH) so a demo run can seed the in-memory quote balance to
// the demo account's actual USDT — keeping the local model close to venue truth. dustNotional reuses
// PROMOTION_DUST_NOTIONAL (the promotion verdict's own dust knob) so live round-trip metrics close
// on the same residual-notional rule the earned-live gate already tolerates; @Optional config in
// module-isolation tests leaves it undefined, which the service treats as disabled (0).
function portfolioConfigFrom(config: TypedConfigService | undefined): PortfolioConfig {
  return {
    quoteAsset: 'USDT',
    startingCash: process.env['STARTING_CASH'] ?? '100000',
    dustNotional: config?.agentic.promotionDustNotional,
  };
}
const DEFAULT_FILTERS: ExecFilters = new Map();
// Monitor limits + reconciliation tunables; the composition root overrides EQUITY_LIMITS from the
// same validated config as the risk limits (§5 C1/C2).
const DEFAULT_EQUITY_LIMITS: EquityLimits = { maxDailyLoss: '5000', maxDrawdownPct: '0.2' };
const DEFAULT_RECON_CONFIG: ReconConfig = {
  epsAbs: '0.00000001',
  epsRel: '0.0001',
  overlapMs: 300_000,
  driftPasses: 3,
  balanceAxis: true,
  sweepSymbols: [],
};
// The balances axis compares local balances (seeded from the synthetic STARTING_CASH) against venue
// truth per asset. On Binance Demo Trading the account is a shared multi-asset wallet the bot does
// not own end-to-end, so BALANCE_DRIFT would HALT on holdings the bot never touched — the axis is
// disabled for that flavor only. Paper (the adapter IS the venue) and the dedicated Spot Testnet
// keep it. sweepSymbols carries the configured trading symbol so the order/trade sweeps observe the
// venue even when no local state exists yet.
function reconConfigFrom(config: TypedConfigService | undefined): ReconConfig {
  if (config === undefined) return DEFAULT_RECON_CONFIG;
  const demoAccount = config.mode.configMode === 'testnet' && config.mode.sandboxEnv === 'demo';
  return {
    ...DEFAULT_RECON_CONFIG,
    balanceAxis: !demoAccount,
    sweepSymbols: config.strategy.symbols,
  };
}

const providers: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  {
    provide: FEED_HEALTH,
    useFactory: (real?: FeedHealthPort): FeedHealthPort => real ?? noopFeedHealth,
    inject: [REAL_FEED_HEALTH_OPTIONAL],
  },
  {
    provide: EXEC_RUN_CONTEXT,
    useFactory: (config?: TypedConfigService): ExecRunContext => runContextFrom(config),
    inject: [CONFIG_OPTIONAL],
  },
  {
    provide: PORTFOLIO_CONFIG,
    useFactory: (config?: TypedConfigService): PortfolioConfig => portfolioConfigFrom(config),
    inject: [CONFIG_OPTIONAL],
  },
  { provide: EXEC_FILTERS, useValue: DEFAULT_FILTERS },
  { provide: EQUITY_LIMITS, useValue: DEFAULT_EQUITY_LIMITS },
  {
    provide: RECON_CONFIG,
    useFactory: (config?: TypedConfigService): ReconConfig => reconConfigFrom(config),
    inject: [CONFIG_OPTIONAL],
  },
  {
    provide: EXEC_OUTBOX,
    useFactory: (override?: ExecOutboxPort): ExecOutboxPort => override ?? new InMemoryExecOutbox(),
    inject: [{ token: EXEC_OUTBOX_OVERRIDE, optional: true }],
  },
  {
    provide: EXECUTION_STORE,
    useFactory: (override?: ExecutionStorePort): ExecutionStorePort =>
      override ?? new InMemoryExecutionStore(),
    inject: [{ token: EXECUTION_STORE_OVERRIDE, optional: true }],
  },
  {
    provide: INSTANCE_LOCK,
    useFactory: (override?: InstanceLockPort): InstanceLockPort =>
      override ?? new InMemoryInstanceLock(),
    inject: [{ token: INSTANCE_LOCK_OVERRIDE, optional: true }],
  },
  NonceLedgerService,
  FeeLedgerService,
  OrderBookService,
  PortfolioStateService,
  EquitySamplerService,
  EquityMonitorService,
  FillIngestorService,
  ExecReportConsumerService,
  ExecutionGateService,
  UnknownResolverService,
  ReconciliationService,
  RECON_MISMATCH_COUNTER,
  RECON_RUNS_COUNTER,
  RECON_LAST_SUCCESS_GAUGE,
  ORDERS_COUNTER,
  ORDERS_REJECTED_COUNTER,
  ORDERS_SUBMITTED_COUNTER,
  ORDERS_SUBMITTED_QTY_COUNTER,
  ORDER_SUBMIT_LATENCY,
  FILLS_COUNTER,
  ORDERS_FILLED_QTY_COUNTER,
  ORDERS_FULLY_FILLED_COUNTER,
  SLIPPAGE_DECISION_HISTOGRAM,
  FEES_PAID_COUNTER,
  ROUND_TRIPS_COUNTER,
  TRADE_PNL_HISTOGRAM,
  CrashRecoveryService,
  BootRecoveryService,
  DemoFillPollerService,
  {
    // In-process delivery hook (an optimisation over the consumer's own cursor/ack loop): a
    // report source can call this to drain promptly. Awaiting it synchronously is how reorder
    // delivery exercises fill-before-ack.
    provide: EXEC_REPORT_NOTIFY,
    useFactory: (consumer: ExecReportConsumerService) => async () => {
      await consumer.pump();
    },
    inject: [ExecReportConsumerService],
  },
  {
    // Post-trade monitors evaluate every equity sample (§5 C1/C2) — the sampler fires this hook.
    provide: EQUITY_OBSERVER,
    useFactory:
      (monitor: EquityMonitorService): EquityObserver =>
      (sample) => {
        monitor.onSample(sample);
      },
    inject: [EquityMonitorService],
  },
  { provide: PORTFOLIO_VIEW, useExisting: PortfolioStateService },
  { provide: EXECUTION_GATE, useExisting: ExecutionGateService },
];

@Module({
  providers,
  exports: [
    EXECUTION_GATE,
    PORTFOLIO_VIEW,
    EXEC_OUTBOX,
    EXEC_REPORT_NOTIFY,
    EXECUTION_STORE,
    CLOCK,
    EXEC_FILTERS,
    FEED_HEALTH,
    INSTANCE_LOCK,
    ExecReportConsumerService,
    PortfolioStateService,
    UnknownResolverService,
    ReconciliationService,
    CrashRecoveryService,
    BootRecoveryService,
    EquitySamplerService,
    // The composition-root trading runtime drives this demo fill poller (fetchMyTrades →
    // FillIngestor) to land venue fills in the portfolio without the (deferred) WS user stream.
    DemoFillPollerService,
  ],
})
export class ExecutionModule {}
