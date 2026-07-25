/**
 * SACRED LIVEGATE SUITE — v3 §7.3 NEW ROWS (mode-control/arming unification, workstream #9).
 *
 * The matrix GROWS here — none of the carried rows in live-gate-matrix.spec.ts or
 * config-override.spec.ts are touched. These eight rows prove the §7.1/§7.2 per-venue key policy:
 * one account, two surfaces (spot + perp), BOTH must validate for live to ever be reached, and
 * neither surface's requirement weakens the other's.
 *
 * Never skip or weaken these to make a suite pass.
 */
import { describe, it, expect } from 'vitest';
import { ModeControlService } from '../../src/features/trading/mode-control/mode-control.service';
import { PromotionReadinessService } from '../../src/features/trading/mode-control/promotion-readiness.service';
import { computeArmingHmac } from '../../src/features/trading/mode-control/hmac';
import { KillSwitchService } from '../../src/features/trading/risk/kill-switch.service';
import { validate } from '../../src/config/environment/environment.config';
import type {
  ModeControlConfig,
  ModeAuditEvent,
  KeyProbeResult,
  ArmPreconditionResult,
} from '../../src/ports/trading/mode-control';
import type {
  PromotionReadinessConfig,
  PromotionStatsPort,
  LlmTokenTotals,
} from '../../src/ports/trading/promotion';
import { epochMs, venueId, type VenueId } from '../../src/domain/common/types/ids';
import { buildVenueExchangePorts } from '../../src/features/trading/composition/exchange-adapters.module';
import { buildVenueRegistry } from '../../src/features/trading/composition/venue-registry.module';
import { InMemoryExecOutbox } from '../../src/features/trading/execution/in-memory-outbox';
import { InMemoryFundingSink } from '../../src/features/venue/exchange/in-memory-funding-sink';
import type { PaperConfig } from '../../src/features/venue/exchange/paper-exchange.adapter';
import type { TypedConfigService } from '../../src/config/environment/typed-config.service';

const T = 1_700_000_000_000;
const SECRET = 'arming-secret';
const BOOT = 'boot-1';
const SPOT = venueId('binance');
const PERP = venueId('binanceusdm');

const validProbe: KeyProbeResult = {
  keysValid: true,
  withdrawalsEnabled: false,
  spotEnabled: true,
  futuresEnabled: true,
  marginEnabled: false,
  keyFingerprint: 'fp',
  urlCrossCheckOk: true,
};
const invalidProbe: KeyProbeResult = {
  keysValid: false,
  withdrawalsEnabled: true,
  spotEnabled: false,
  futuresEnabled: false,
  marginEnabled: false,
  keyFingerprint: 'none',
  urlCrossCheckOk: false,
};

function build(over: Partial<ModeControlConfig> = {}) {
  const t = T;
  const clock = { now: () => epochMs(t) };
  const events: ModeAuditEvent[] = [];
  const audit = {
    record: (e: ModeAuditEvent) => {
      events.push(e);
    },
  };
  let probes = new Map<VenueId, KeyProbeResult>([
    [SPOT, invalidProbe],
    [PERP, invalidProbe],
  ]);
  const keyProbe = { probeAll: () => Promise.resolve(new Map(probes)) };
  const killSwitch = new KillSwitchService();
  const precond: ArmPreconditionResult = { ok: true };
  const preconditions = { check: () => precond };
  const cfg: ModeControlConfig = {
    requested: 'paper',
    bootId: BOOT,
    armingSecret: SECRET,
    limitsComplete: true,
    ...over,
  };
  const svc = new ModeControlService(clock, keyProbe, killSwitch, audit, preconditions, cfg);
  return {
    svc,
    events,
    killSwitch,
    setVenueProbe: (venue: VenueId, p: KeyProbeResult) => {
      probes = new Map(probes);
      probes.set(venue, p);
    },
    setProbe: (p: KeyProbeResult) => {
      probes = new Map([
        [SPOT, p],
        [PERP, p],
      ]);
    },
  };
}

// Drive a real arm: REQUEST → compute the genuine HMAC over the issued challenge → CONFIRM. Arming
// mechanics succeed independent of key validity (the sacred 2⁴ matrix's own invariant) — every row
// below asserts resolveMode().effective, the axis key validity actually gates.
function arm(ctx: ReturnType<typeof build>): void {
  const req = ctx.svc.armLive({ step: 'REQUEST', bootId: BOOT });
  if (!req.ok || req.challengeId === undefined) throw new Error('REQUEST failed');
  const hmacHex = computeArmingHmac(req.challengeId, BOOT, SECRET);
  const res = ctx.svc.armLive({
    step: 'CONFIRM',
    challengeId: req.challengeId,
    hmacHex,
    bootId: BOOT,
  });
  if (!res.ok) throw new Error('CONFIRM failed: ' + res.reason);
}

describe('LIVE-GATE MATRIX — v3 §7.3 new row (1)/(2): per-venue veto', () => {
  it('spot-valid + perp-invalid ⇒ live is refused (perp vetoes the whole book)', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setVenueProbe(SPOT, validProbe);
    ctx.setVenueProbe(PERP, invalidProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('perp-valid + spot-invalid ⇒ live is refused (spot vetoes the whole book)', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setVenueProbe(SPOT, invalidProbe);
    ctx.setVenueProbe(PERP, validProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });
});

describe('LIVE-GATE MATRIX — v3 §7.3 new row (3): probe-unreachable fails CLOSED', () => {
  // A genuinely-missing map entry models "this venue's probe never answered" (unreachable) — the
  // KeyProbePort contract's failure mode a real network timeout/exception degrades to at the
  // KeyProbeService layer. keysValid()'s explicit spot/perp presence check must fail CLOSED here,
  // never vacuously pass because the loop found nothing to disagree with.
  function svcWithProbe(probeAll: () => Promise<ReadonlyMap<VenueId, KeyProbeResult>>) {
    const clock = { now: () => epochMs(T) };
    const audit = { record: () => undefined };
    const keyProbe = { probeAll };
    const killSwitch = new KillSwitchService();
    const preconditions = { check: () => ({ ok: true }) };
    const cfg: ModeControlConfig = {
      requested: 'live',
      bootId: BOOT,
      armingSecret: SECRET,
      limitsComplete: true,
    };
    return new ModeControlService(clock, keyProbe, killSwitch, audit, preconditions, cfg);
  }
  function armAndResolve(svc: ModeControlService) {
    const req = svc.armLive({ step: 'REQUEST', bootId: BOOT });
    if (!req.ok || req.challengeId === undefined) throw new Error('REQUEST failed');
    const hmacHex = computeArmingHmac(req.challengeId, BOOT, SECRET);
    svc.armLive({ step: 'CONFIRM', challengeId: req.challengeId, hmacHex, bootId: BOOT });
    return svc.resolveMode().effective;
  }

  it('a probeAll() response missing the perp entry only (perp unreachable) refuses live', async () => {
    const svc = svcWithProbe(() => Promise.resolve(new Map([[SPOT, validProbe]])));
    await svc.refreshKeyProbe();
    expect(armAndResolve(svc)).toBe('paper');
  });

  it('a probeAll() response missing BOTH entries (fully unreachable) refuses live', async () => {
    const svc = svcWithProbe(() => Promise.resolve(new Map<VenueId, KeyProbeResult>()));
    await svc.refreshKeyProbe();
    expect(armAndResolve(svc)).toBe('paper');
  });
});

// v3 §7.3 new row (4): "two live adapters constructed on a live boot, each behind LIVE_ADAPTER_CAP,
// both test/ci-throwing". Workstream #5's exchange-adapters.module.ts now exists — flipped from
// `it.skip` to `it` per the #5/#9 integration handshake. Today's SINGLE-adapter test/ci-throw
// property remains separately pinned in test/unit/exchange-adapter/live-exchange.adapter.spec.ts and
// test/unit/execution/app-module.boot.spec.ts (both carried, untouched).
describe('LIVE-GATE MATRIX — v3 §7.3 new row (4): two live adapters, both test/ci-throwing', () => {
  function liveConfig(venues: readonly { id: string; environment: string }[]): TypedConfigService {
    return {
      mode: { configMode: 'live', sandboxEnv: 'demo' },
      liveSecrets: { liveApiKey: 'k', liveApiSecret: 's' },
      perp: { leverageCap: '2', mmrFallback: '0.005' },
      strategy: { symbols: ['BTC/USDT', 'BTC/USDT:USDT'], active: 'agentic' },
      venues,
      venueCapitalSplit: { binance: '500', binanceusdm: '500' },
    } as unknown as TypedConfigService;
  }

  const clock = { now: () => epochMs(T) };
  const PAPER_CFG: PaperConfig = {
    seed: 1,
    takerBuffer: '0.05',
    fees: { makerBps: '10', takerBps: '10', feeCurrency: 'quote' },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    startingBalances: { USDT: '100000' },
  };

  it('constructing the spot LiveExchangeAdapter alone throws under NODE_ENV=test/CI', () => {
    const config = liveConfig([{ id: 'binance', environment: 'live' }]);
    const registry = buildVenueRegistry(config);
    expect(() =>
      buildVenueExchangePorts(
        registry,
        config,
        clock,
        new InMemoryExecOutbox(),
        () => Promise.resolve(),
        PAPER_CFG,
        new InMemoryFundingSink(),
      ),
    ).toThrow(/must never be constructed under NODE_ENV=test\/ci/);
  });

  it('constructing the perp LiveExchangeAdapter alone throws under NODE_ENV=test/CI — neither venue silently succeeds because the other venue is absent', () => {
    const config = liveConfig([{ id: 'binanceusdm', environment: 'live' }]);
    const registry = buildVenueRegistry(config);
    expect(() =>
      buildVenueExchangePorts(
        registry,
        config,
        clock,
        new InMemoryExecOutbox(),
        () => Promise.resolve(),
        PAPER_CFG,
        new InMemoryFundingSink(),
      ),
    ).toThrow(/must never be constructed under NODE_ENV=test\/ci/);
  });
});

describe('LIVE-GATE MATRIX — v3 §7.3 new row (5): VENUES missing a venue refuses at config, before any adapter', () => {
  const BASE_ENV = {
    TRADING_MODE: 'live',
    PORT: '3100',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    VENUE_CAPITAL_SPLIT: '{"binance":"1000"}',
    AGENTIC_ACTIVE_MENU_SIZE: '1',
  };

  it('TRADING_SYMBOLS implies both spot+perp but VENUES declares only spot ⇒ config refusal', () => {
    // No NODE_ENV/CI ⇒ outside test/ci ⇒ the VENUES-coverage refusal is live (§3.2/§3.5).
    const env = {
      ...BASE_ENV,
      TRADING_SYMBOLS: 'BTC/USDT,BTC/USDT:USDT', // implies binance AND binanceusdm
      VENUES: '[{"id":"binance","environment":"demo"}]', // only spot declared
    };
    expect(() => validate(env)).toThrow(/VENUES.*must exactly cover/);
  });

  it('TRADING_SYMBOLS implies both spot+perp but VENUES declares only perp ⇒ config refusal', () => {
    const env = {
      ...BASE_ENV,
      TRADING_SYMBOLS: 'BTC/USDT,BTC/USDT:USDT',
      VENUES: '[{"id":"binanceusdm","environment":"demo"}]', // only perp declared
      VENUE_CAPITAL_SPLIT: '{"binanceusdm":"1000"}',
    };
    expect(() => validate(env)).toThrow(/VENUES.*must exactly cover/);
  });

  it('VENUES declaring BOTH venues (matching TRADING_SYMBOLS) validates cleanly — the control case', () => {
    const env = {
      ...BASE_ENV,
      TRADING_SYMBOLS: 'BTC/USDT,BTC/USDT:USDT',
      VENUES: '[{"id":"binance","environment":"demo"},{"id":"binanceusdm","environment":"demo"}]',
      VENUE_CAPITAL_SPLIT: '{"binance":"500","binanceusdm":"500"}',
      AGENTIC_ACTIVE_MENU_SIZE: '2',
    };
    expect(() => validate(env)).not.toThrow();
  });
});

describe('LIVE-GATE MATRIX — v3 §7.3 new row (6): promotion verdict is book-scoped, no venue predicate', () => {
  const CFG: PromotionReadinessConfig = {
    tokenPriceInputPerMtok: '3',
    tokenPriceOutputPerMtok: '15',
    dustNotional: '5',
  };
  const ZERO_TOKENS: LlmTokenTotals = { perModel: [] };

  it('evaluate() calls fillsForMode/llmTokenTotals with (mode, sinceMs) ONLY — no venue argument reaches the query', async () => {
    const fillsForModeArgs: unknown[][] = [];
    const llmTokenTotalsArgs: unknown[][] = [];
    const stats: PromotionStatsPort = {
      fillsForMode: (...args: unknown[]) => {
        fillsForModeArgs.push(args);
        return Promise.resolve([]);
      },
      llmTokenTotals: (...args: unknown[]) => {
        llmTokenTotalsArgs.push(args);
        return Promise.resolve(ZERO_TOKENS);
      },
    };
    const svc = new PromotionReadinessService(stats, CFG);
    await svc.evaluate();
    // A venue-filtered evidence read in the gate is itself a livegate failure (§7.3 row 6) — the
    // query-shape assertion is exactly this length check: mode(+sinceMs), never mode+venue.
    expect(fillsForModeArgs).toEqual([['testnet', undefined]]);
    expect(llmTokenTotalsArgs).toEqual([[undefined]]);
  });
});

describe('LIVE-GATE MATRIX — v3 §7.3 new row (7): withdrawals-enabled on either surface invalidates that surface', () => {
  it('withdrawals enabled on spot only invalidates spot; perp (independently valid) still refuses the whole book', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setVenueProbe(SPOT, { ...validProbe, withdrawalsEnabled: true, keysValid: false });
    ctx.setVenueProbe(PERP, validProbe);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('withdrawals enabled on perp only invalidates perp; spot (independently valid) still refuses the whole book', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setVenueProbe(SPOT, validProbe);
    ctx.setVenueProbe(PERP, { ...validProbe, withdrawalsEnabled: true, keysValid: false });
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });
});

describe('LIVE-GATE MATRIX — v3 §7.3 new row (8): the perp futures-requirement never weakens the spot margin prohibition', () => {
  it('margin (cross-margin borrow) enabled invalidates BOTH venues even though futures is separately enabled', async () => {
    const ctx = build({ requested: 'live' });
    const marginEnabledBoth: KeyProbeResult = {
      ...validProbe,
      marginEnabled: true,
      keysValid: false,
    };
    ctx.setProbe(marginEnabledBoth);
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });

  it('spot alone valid + perp futures-enabled does NOT grant live while margin remains enabled', async () => {
    const ctx = build({ requested: 'live' });
    ctx.setVenueProbe(SPOT, { ...validProbe, marginEnabled: true, keysValid: false });
    ctx.setVenueProbe(PERP, {
      ...validProbe,
      futuresEnabled: true,
      marginEnabled: true,
      keysValid: false,
    });
    await ctx.svc.refreshKeyProbe();
    arm(ctx);
    expect(ctx.svc.resolveMode().effective).toBe('paper');
  });
});
