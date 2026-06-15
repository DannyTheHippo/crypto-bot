import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLOCK, SystemClock } from '../../ports/clock';
import { FEED_HEALTH, REAL_FEED_HEALTH, type FeedHealthPort } from '../../ports/market-data';
import type { AppConfig } from '../../ports/app-config';
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
} from '../../ports/execution';
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
const CONFIG_OPTIONAL = { token: ConfigService, optional: true } as const;

// EXEC_RUN_CONTEXT.mode must track the boot config authority (paper/testnet/live) — it stamps the
// run and must agree with the mode the sizer brands intents with. ConfigService is @Optional so the
// module-isolation boot specs (no AppConfigModule) keep the paper defaults.
function runContextFrom(config: ConfigService<AppConfig, true> | undefined): ExecRunContext {
  if (config === undefined) return { mode: 'paper', runId: 'paper-local', bootId: 'boot-local' };
  const bootId = config.get('app', { infer: true }).bootId;
  return { mode: config.get('mode', { infer: true }).configMode, runId: `run-${bootId}`, bootId };
}
// startingCash is env-tunable (STARTING_CASH) so a demo run can seed the in-memory quote balance to
// the demo account's actual USDT — keeping the local model close to venue truth.
function portfolioConfigFrom(config: ConfigService<AppConfig, true> | undefined): PortfolioConfig {
  void config;
  return { quoteAsset: 'USDT', startingCash: process.env['STARTING_CASH'] ?? '100000' };
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
};

const providers: Provider[] = [
  { provide: CLOCK, useClass: SystemClock },
  {
    provide: FEED_HEALTH,
    useFactory: (real?: FeedHealthPort): FeedHealthPort => real ?? noopFeedHealth,
    inject: [REAL_FEED_HEALTH_OPTIONAL],
  },
  {
    provide: EXEC_RUN_CONTEXT,
    useFactory: (config?: ConfigService<AppConfig, true>): ExecRunContext => runContextFrom(config),
    inject: [CONFIG_OPTIONAL],
  },
  {
    provide: PORTFOLIO_CONFIG,
    useFactory: (config?: ConfigService<AppConfig, true>): PortfolioConfig =>
      portfolioConfigFrom(config),
    inject: [CONFIG_OPTIONAL],
  },
  { provide: EXEC_FILTERS, useValue: DEFAULT_FILTERS },
  { provide: EQUITY_LIMITS, useValue: DEFAULT_EQUITY_LIMITS },
  { provide: RECON_CONFIG, useValue: DEFAULT_RECON_CONFIG },
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
