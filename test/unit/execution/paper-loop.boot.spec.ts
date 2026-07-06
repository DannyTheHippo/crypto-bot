import { describe, it, expect } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RiskModule } from '../../../src/features/trading/risk/risk.module';
import { KillSwitchService } from '../../../src/features/trading/risk/kill-switch.service';
import { ExecutionModule } from '../../../src/features/trading/execution/execution.module';
import { SignalSinkService } from '../../../src/features/trading/execution/signal-sink.service';
import {
  PaperExchangeAdapter,
  PAPER_CONFIG,
  type PaperConfig,
} from '../../../src/features/trading/exchange/paper-exchange.adapter';
import { CLOCK, type ClockPort } from '../../../src/ports/clock';
import { FEED_HEALTH, type FeedHealthPort } from '../../../src/ports/market-data';
import { RISK_SIGNING_KEY, KILL_SWITCH } from '../../../src/ports/risk';
import { MODE_CONTROL, type ModeControlPort } from '../../../src/ports/mode-control';
import {
  EXECUTION_GATE,
  PORTFOLIO_VIEW,
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  type ExecOutboxPort,
  type ExecReportNotify,
} from '../../../src/ports/execution';
import { EXCHANGE_PORT } from '../../../src/ports/exchange';
import { price } from '../../../src/domain/types/money';
import { epochMs, venueId } from '../../../src/domain/types/ids';

// DI boot validation (advisor #3): bring up the trading module graph with no DB. Resolving
// EXECUTION_GATE transitively instantiates the whole execution chain (paper adapter, outbox,
// consumer, notify, configs); resolving SignalSinkService validates the cross-module Risk↔
// Execution wiring (SIGNAL_GATEWAY + the single shared RISK_SIGNING_KEY). A missing provider or
// token mismatch fails here — what direct-construction unit tests cannot catch. The
// signal→fill→position behaviour is exercised in the deterministic paper suite.
const T = 1_700_000_000_000;
const KEY = Buffer.alloc(32, 5);
const fedFeed: FeedHealthPort = {
  getRefPrice: () => ({ mid: price('100'), at: epochMs(T) }),
  health: () => 'LIVE',
  fetchCandles: () => Promise.resolve([]),
};

const PAPER_CFG: PaperConfig = {
  seed: 1,
  takerBuffer: '0.05',
  fees: { makerBps: '1', takerBps: '10', feeCurrency: 'quote' },
  latency: { submitMs: [0, 0], eventMs: [0, 0] },
  insufficientDepthPolicy: 'partial_then_reject_rest',
  startingBalances: { USDT: '100000' },
};

@Global()
@Module({ providers: [{ provide: RISK_SIGNING_KEY, useValue: KEY }], exports: [RISK_SIGNING_KEY] })
class KeyModule {}

// Mirrors app.module's single global kill switch shared by Risk + Execution.
@Global()
@Module({
  providers: [KillSwitchService, { provide: KILL_SWITCH, useExisting: KillSwitchService }],
  exports: [KillSwitchService, KILL_SWITCH],
})
class KillSwitchModule {}

// Mirrors app.module's global MODE_CONTROL (the ExecutionGate now consults it per submission). A
// paper stub suffices here — the real config-driven ModeControlModule is exercised by app-module.boot.
const paperModeControl: ModeControlPort = {
  resolveMode: () => ({ effective: 'paper', requested: 'paper', downgrades: [] }),
  armLive: () => ({ ok: true }),
  disarm: () => undefined,
  assertCanTrade: () => undefined,
};
@Global()
@Module({
  providers: [{ provide: MODE_CONTROL, useValue: paperModeControl }],
  exports: [MODE_CONTROL],
})
class ModeControlStubModule {}

// Mirrors app.module's composition-root binding of EXCHANGE_PORT → PaperExchangeAdapter.
@Global()
@Module({
  imports: [ExecutionModule],
  providers: [
    { provide: PAPER_CONFIG, useValue: PAPER_CFG },
    {
      provide: EXCHANGE_PORT,
      useFactory: (
        clock: ClockPort,
        outbox: ExecOutboxPort,
        notify: ExecReportNotify,
        cfg: PaperConfig,
      ) => new PaperExchangeAdapter(clock, outbox, notify, cfg, venueId('binance')),
      inject: [CLOCK, EXEC_OUTBOX, EXEC_REPORT_NOTIFY, PAPER_CONFIG],
    },
  ],
  exports: [EXCHANGE_PORT],
})
class PaperExchangeModule {}

describe('paper loop DI boot', () => {
  it('resolves the trading module graph (no DB, no token mismatches)', async () => {
    const ref = await Test.createTestingModule({
      imports: [
        KeyModule,
        KillSwitchModule,
        ModeControlStubModule,
        RiskModule,
        ExecutionModule,
        PaperExchangeModule,
      ],
      providers: [SignalSinkService],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => epochMs(T) })
      .overrideProvider(FEED_HEALTH)
      .useValue(fedFeed)
      .compile();

    expect(ref.get(EXECUTION_GATE, { strict: false })).toBeDefined(); // forces the whole execution chain
    expect(ref.get(PORTFOLIO_VIEW, { strict: false })).toBeDefined();
    expect(ref.get(SignalSinkService)).toBeDefined(); // Risk↔Execution cross-wiring + shared key
    await ref.close();
  });
});
