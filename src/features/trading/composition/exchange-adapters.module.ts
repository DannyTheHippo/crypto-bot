import { Global, Module } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { ExecutionModule } from '../execution/execution.module';
import type { VenueConfig, VenueEnvironment } from '../../../ports/common/app-config';
import { CLOCK, type ClockPort } from '../../../ports/common/clock';
import { LIVE_ADAPTER_CAP } from '../../../ports/trading/mode-control';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  type ExecOutboxPort,
  type ExecReportNotify,
} from '../../../ports/trading/execution';
import {
  EXCHANGE_PORT,
  VENUE_EXCHANGE_PORTS,
  type ExchangePort,
  type PlaceOrderRequest,
  type ExchangeAck,
  type ExchangeOrderState,
  type VenueFill,
  type CredentialCheck,
  type VenueCapabilities,
  type AlgoOrderState,
  type AlgoOrderHistoryView,
  type VenuePosition,
  type VenueFundingPayment,
} from '../../../ports/venue/exchange';
import type { ClientOrderId, SymbolId, EpochMs } from '../../../domain/common/types/ids';
import { venueId, type VenueId } from '../../../domain/common/types/ids';
import { venueForSymbol, PERP_VENUE } from '../../../domain/venue/types/venue-map';
import { assertSwapPrivateUrlSafe } from '../../../shared/venue-safety/swap-url-guard';
import { buildCcxtExchange } from '../../venue/market-data/ccxt-stream.adapter';
import { RealCcxtOrderClient } from '../../venue/exchange/ccxt-order-client';
import { CcxtExchangeAdapter } from '../../venue/exchange/ccxt-exchange.adapter';
import { LiveExchangeAdapter } from '../../venue/exchange/live-exchange.adapter';
import {
  PaperExchangeAdapter,
  PAPER_CONFIG,
  type PaperConfig,
} from '../../venue/exchange/paper-exchange.adapter';
import {
  PaperPerpAdapter,
  FUNDING_SINK,
  type PaperPerpConfig,
  type FundingSinkPort,
} from '../../venue/exchange/paper-perp.adapter';
// FUNDING_SINK substrate pair: the Drizzle writer for funding_events (the append-only journal
// PaperPerpAdapter.applyFunding produces, distinct from the funding_payments venue-ingest table §6
// owns) whenever a database is present, InMemoryFundingSink for the no-DB/test substrate — the same
// isTestEnv()/db===null split PersistenceOverridesModule applies to every other durable writer.
import { InMemoryFundingSink } from '../../venue/exchange/in-memory-funding-sink';
import { FundingEventsRepository } from '../../../database/repositories/trading/funding-events.repository';
import { PersistenceModule } from '../../../database/database.module';
import { DRIZZLE_DB } from '../../../database/database.tokens';
import type * as dbSchema from '../../../database/schemas/trading';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue/venue-registry';
import { feeScheduleForVenue } from '../../../domain/trading/fees';
import { SPOT_VENUE_ID } from '../../../domain/venue/types/venue-map';

// v3 spec §1.3: ExchangeAdaptersModule replaces PaperExchangeModule. VENUE_EXCHANGE_PORTS (token
// defined in ports/venue/exchange.ts — see that file for why) holds one concrete ExchangePort per registry
// venue (paper/testnet/demo/live per configMode, exactly mirroring app.module.ts's retired
// single-venue PaperExchangeModule branch-per-mode); EXCHANGE_PORT re-binds to the
// VenueRoutingExchangeAdapter facade so every existing single-injection call site (Risk engine, OMS,
// KillSwitch flatten, protective exits) keeps injecting one port and gets dispatched to the right
// venue by the `venue`/`symbol` argument already on every call.
export { VENUE_EXCHANGE_PORTS };

// Push II Phase 8: the futures-demo venue's private base URL, read off the ccxt instance AFTER
// enableDemoTrading/setSandboxMode has mutated it — moved verbatim from app.module.ts.
function swapPrivateUrl(exchange: ReturnType<typeof buildCcxtExchange>): string {
  return (exchange as unknown as { urls: { api: { fapiPrivate: string } } }).urls.api.fapiPrivate;
}

// Spot rail counterpart of swapPrivateUrl: ccxt 4.5.58 keys the spot private REST base as
// urls.api.private (urls.api.sapi — the endpoint KeyProbeService actually calls — exists on the LIVE
// tree only, which is why the sandbox rails must be cross-checked on `private` instead).
function spotPrivateUrl(exchange: ReturnType<typeof buildCcxtExchange>): string {
  return (exchange as unknown as { urls: { api: { private: string } } }).urls.api.private;
}

// The effective PRIVATE REST base a venue would trade through in the given environment, read off a
// ccxt instance built by the SAME buildCcxtExchange path buildOrderClient uses — so the url tree has
// already been mutated by setSandboxMode/enableDemoTrading (buildOrderClient only sets credentials
// afterwards, never a url). Keyless and offline: url resolution makes no network call, so the
// composition root can cross-check a rail's host without paying a venue round trip. Exported for
// key-probe.module.ts, which feeds it to live gate (c)'s urlCrossCheckOk conjunct.
export function venuePrivateUrl(venue: string, environment: VenueEnvironment): string {
  const exchange = buildCcxtExchange({ id: venue, environment });
  return venue === PERP_VENUE ? swapPrivateUrl(exchange) : spotPrivateUrl(exchange);
}

// Build a credentialed ccxt order client for a real venue (testnet/live). Reached only on a
// non-paper boot — under test/ci configMode is forced paper, so this never runs in CI. Exported for
// key-probe.module.ts, which needs the SAME construction (+ the same swap-URL safety guard) to build
// its one account-wide credentialed client — duplicating this would risk the two composition modules
// drifting on a security-relevant guard.
export function buildOrderClient(
  venue: string,
  environment: VenueEnvironment,
  apiKey: string,
  secret: string,
): RealCcxtOrderClient {
  const venueConfig: VenueConfig = { id: venue, environment };
  const exchange = buildCcxtExchange(venueConfig);
  if (venue === PERP_VENUE) {
    assertSwapPrivateUrlSafe(swapPrivateUrl(exchange), environment);
  }
  exchange.apiKey = apiKey;
  exchange.secret = secret;
  return new RealCcxtOrderClient(exchange);
}

// §3.5: in testnet mode the sandbox FLAVOR (SANDBOX_ENV) picks the environment and its own
// non-interchangeable keys — shared by both venues (one account, two wallets). Exported for
// key-probe.module.ts (same rationale as buildOrderClient above).
export function resolveSandbox(config: TypedConfigService): {
  environment: VenueEnvironment;
  apiKey: string;
  secret: string;
} {
  if (config.mode.sandboxEnv === 'demo') {
    return {
      environment: 'demo',
      apiKey: process.env['BINANCE_DEMO_API_KEY'] ?? '',
      secret: process.env['BINANCE_DEMO_API_SECRET'] ?? '',
    };
  }
  return {
    environment: 'testnet',
    apiKey: process.env['BINANCE_TESTNET_API_KEY'] ?? '',
    secret: process.env['BINANCE_TESTNET_API_SECRET'] ?? '',
  };
}

function buildPaperPerpConfig(
  config: TypedConfigService,
  descriptor: VenueRuntimeDescriptor,
): PaperPerpConfig {
  // Fees come from domain/trading/fees.ts, the same table the take-profit gate and the system
  // prompt read, so the paper simulator can never charge a schedule the live lane does not quote.
  // Arithmetically identical today (both venues still carry 10/10 pending a separate enable) — the
  // point is that the pending perp flip reaches the simulator in the same commit as everything else.
  const { makerBps, takerBps } = feeScheduleForVenue(descriptor.venue);
  return {
    seed: 1,
    fees: { makerBps, takerBps },
    latency: { submitMs: [0, 0], eventMs: [0, 0] },
    insufficientDepthPolicy: 'partial_then_reject_rest',
    settlementAsset: 'USDT',
    startingMargin: descriptor.capitalShare,
    leverage: config.perp.leverageCap,
    mmrFallback: config.perp.mmrFallback,
    mode: 'paper',
    strategyId: config.strategy.active,
  };
}

function buildExchangePortFor(
  descriptor: VenueRuntimeDescriptor,
  config: TypedConfigService,
  clock: ClockPort,
  outbox: ExecOutboxPort,
  notify: ExecReportNotify,
  paperConfig: PaperConfig,
  fundingSink: FundingSinkPort,
): ExchangePort {
  const mode = config.mode.configMode;
  const venue = descriptor.venue;
  if (mode === 'live') {
    const client = buildOrderClient(
      venue,
      'live',
      config.liveSecrets.liveApiKey ?? '',
      config.liveSecrets.liveApiSecret ?? '',
    );
    return new LiveExchangeAdapter(
      LIVE_ADAPTER_CAP,
      new CcxtExchangeAdapter(client, venueId(venue), false),
    );
  }
  if (mode === 'testnet') {
    const sandbox = resolveSandbox(config);
    const client = buildOrderClient(venue, sandbox.environment, sandbox.apiKey, sandbox.secret);
    return new CcxtExchangeAdapter(client, venueId(venue), true);
  }
  // Paper: spot uses PaperExchangeAdapter (base/quote custody); perp uses PaperPerpAdapter (signed
  // position ledger + isolated margin) — each seeded with its OWN venue's capitalShare, so the paper
  // book mirrors the fixed VENUE_CAPITAL_SPLIT by construction (§6.1's `venueFree(v)` reads exactly
  // this balance).
  if (descriptor.perpCapable) {
    return new PaperPerpAdapter(
      clock,
      outbox,
      notify,
      fundingSink,
      buildPaperPerpConfig(config, descriptor),
      venueId(venue),
    );
  }
  const venuePaperConfig: PaperConfig = {
    ...paperConfig,
    startingBalances: { USDT: descriptor.capitalShare },
  };
  return new PaperExchangeAdapter(clock, outbox, notify, venuePaperConfig, venueId(venue));
}

export function buildVenueExchangePorts(
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  config: TypedConfigService,
  clock: ClockPort,
  outbox: ExecOutboxPort,
  notify: ExecReportNotify,
  paperConfig: PaperConfig,
  fundingSink: FundingSinkPort,
): ReadonlyMap<VenueId, ExchangePort> {
  const ports = new Map<VenueId, ExchangePort>();
  for (const descriptor of registry.values()) {
    ports.set(
      descriptor.venue,
      buildExchangePortFor(descriptor, config, clock, outbox, notify, paperConfig, fundingSink),
    );
  }
  return ports;
}

// §1.2/§1.3: the routing facade. Fail direction: an unroutable venue (a symbol whose venueForSymbol
// resolves to a venue absent from the map, or an explicit venue argument absent from the map) THROWS
// — fail CLOSED, a mis-routed order is a wrong-venue trade, never a silently dropped/degraded one.
export class VenueRoutingExchangeAdapter implements ExchangePort {
  // Unused by any production call site (grep-verified: only funding-ingest.service.ts and
  // reconciliation.service.ts ever read `exchangePort.venue`, and both are wired directly off
  // VENUE_EXCHANGE_PORTS in v3, bypassing this facade) — kept only to satisfy ExchangePort's
  // non-optional `venue` field. Reports the first registered venue as a harmless, deterministic value.
  readonly venue: VenueId;
  readonly capabilities: VenueCapabilities;

  constructor(private readonly ports: ReadonlyMap<VenueId, ExchangePort>) {
    const first = ports.values().next();
    if (first.done) {
      throw new Error('VenueRoutingExchangeAdapter requires at least one venue port');
    }
    this.venue = first.value.venue;
    this.capabilities = first.value.capabilities;
  }

  private portFor(venue: VenueId): ExchangePort {
    const port = this.ports.get(venue);
    if (!port) {
      throw new Error(`VenueRoutingExchangeAdapter: no exchange port for venue "${venue}"`);
    }
    return port;
  }

  private portForSymbol(symbol: SymbolId): ExchangePort {
    return this.portFor(venueForSymbol(symbol));
  }

  private perpPort(): ExchangePort | undefined {
    return [...this.ports.entries()].find(([venue]) => venue === PERP_VENUE)?.[1];
  }

  // Dispatch methods are declared `async` (rather than returning the inner promise directly) so a
  // fail-CLOSED unroutable-venue throw from portForSymbol/portFor always surfaces as a REJECTED
  // promise, never a synchronous throw — callers that only ever `await`/`.catch()` an ExchangePort
  // method must not have to also wrap the call itself in a try/catch.
  async placeOrder(req: PlaceOrderRequest): Promise<ExchangeAck> {
    return this.portForSymbol(req.symbol).placeOrder(req);
  }

  async cancelOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeAck> {
    return this.portForSymbol(symbol).cancelOrder(clientOrderId, symbol);
  }

  async fetchOrder(clientOrderId: ClientOrderId, symbol: SymbolId): Promise<ExchangeOrderState> {
    return this.portForSymbol(symbol).fetchOrder(clientOrderId, symbol);
  }

  async fetchOpenOrders(symbol?: SymbolId): Promise<readonly ExchangeOrderState[]> {
    if (symbol !== undefined) return this.portForSymbol(symbol).fetchOpenOrders(symbol);
    const perVenue = await Promise.all([...this.ports.values()].map((p) => p.fetchOpenOrders()));
    return perVenue.flat();
  }

  // Book-level aggregate: sums free/locked per asset across every venue wallet. No production call
  // site reaches this path today (reconciliation.service.ts calls VENUE_EXCHANGE_PORTS per-venue
  // directly, §1.5) — kept for interface completeness and any future book-wide read. Decimal
  // arithmetic throughout (hard rule 1 — money never crosses as a native float).
  async fetchBalances(): Promise<ReadonlyMap<string, { free: string; locked: string }>> {
    const perVenue = await Promise.all([...this.ports.values()].map((p) => p.fetchBalances()));
    const merged = new Map<string, { free: Decimal; locked: Decimal }>();
    for (const balances of perVenue) {
      for (const [asset, balance] of balances) {
        const prior = merged.get(asset) ?? { free: new Decimal(0), locked: new Decimal(0) };
        merged.set(asset, {
          free: prior.free.plus(balance.free),
          locked: prior.locked.plus(balance.locked),
        });
      }
    }
    return new Map(
      [...merged].map(([asset, b]) => [
        asset,
        { free: b.free.toString(), locked: b.locked.toString() },
      ]),
    );
  }

  async fetchMyTrades(symbol: SymbolId, since: EpochMs): Promise<readonly VenueFill[]> {
    return this.portForSymbol(symbol).fetchMyTrades(symbol, since);
  }

  // Unused in production (superseded by KEY_PROBE's per-venue AND-aggregate, §7.1) — delegates to
  // an arbitrary venue only to satisfy the interface.
  async validateCredentials(): Promise<CredentialCheck> {
    return this.portFor(this.venue).validateCredentials();
  }

  // Perp-only rail: filters the caller's symbols down to the perp venue's own subset (defensive —
  // callers are expected to pass only perp symbols, but a mixed list must never leak a spot symbol's
  // notional into the perp pin call). No-ops (never even calls the perp port) when no symbol in the
  // list resolves to the perp venue, or when the paper/spot-only registry has no perp venue at all.
  async pinPerpVenueDefaults(symbols: readonly SymbolId[], leverage: number): Promise<void> {
    const perp = this.perpPort();
    if (!perp?.pinPerpVenueDefaults) return;
    const perpSymbols = symbols.filter((s) => venueForSymbol(s) === PERP_VENUE);
    if (perpSymbols.length === 0) return;
    await perp.pinPerpVenueDefaults(perpSymbols, leverage);
  }

  async fetchOpenAlgoOrders(symbol?: SymbolId): Promise<readonly AlgoOrderState[]> {
    if (symbol !== undefined) {
      const port = this.portForSymbol(symbol);
      return (await port.fetchOpenAlgoOrders?.(symbol)) ?? [];
    }
    const perp = this.perpPort();
    return (await perp?.fetchOpenAlgoOrders?.()) ?? [];
  }

  async cancelAlgoOrder(algoId: string, symbol: SymbolId): Promise<void> {
    await this.portForSymbol(symbol).cancelAlgoOrder?.(algoId, symbol);
  }

  async fetchAlgoOrderStatus(
    clientAlgoId: string,
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<AlgoOrderHistoryView | undefined> {
    return this.portForSymbol(symbol).fetchAlgoOrderStatus?.(clientAlgoId, symbol, sinceMs);
  }

  async fetchPositions(symbols?: readonly SymbolId[]): Promise<readonly VenuePosition[]> {
    if (symbols !== undefined && symbols.length > 0) {
      const byVenue = new Map<VenueId, SymbolId[]>();
      for (const s of symbols) {
        const v = venueForSymbol(s);
        const list = byVenue.get(v) ?? [];
        list.push(s);
        byVenue.set(v, list);
      }
      const results = await Promise.all(
        [...byVenue.entries()].map(
          ([v, syms]) => this.portFor(v).fetchPositions?.(syms) ?? Promise.resolve([]),
        ),
      );
      return results.flat();
    }
    const results = await Promise.all(
      [...this.ports.values()].map((p) => p.fetchPositions?.() ?? Promise.resolve([])),
    );
    return results.flat();
  }

  async fetchFundingPayments(
    symbol: SymbolId,
    sinceMs: EpochMs,
  ): Promise<readonly VenueFundingPayment[]> {
    return (await this.portForSymbol(symbol).fetchFundingPayments?.(symbol, sinceMs)) ?? [];
  }
}

// Local copy, matching every other composition module's own (venue-registry, kill-switch,
// persistence-overrides): the hermetic suite must never reach a database handle.
function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

// FUNDING_SINK selection. Fail direction: this is a durability writer, not a gate — with no database
// it falls back to the in-memory sink rather than refusing to boot (a paper boot has no DB by
// design, and a dropped funding-simulation row must never stop the trading loop). Config refuses a
// non-test boot without DATABASE_URL upstream (§3), so the fallback is reachable only under
// test/ci/no-DB — exactly where InMemoryExecOutbox backs EXEC_OUTBOX.
function spotPaperFees(): { makerBps: string; takerBps: string } {
  const { makerBps, takerBps } = feeScheduleForVenue(SPOT_VENUE_ID);
  return { makerBps, takerBps };
}

export function buildFundingSink(db: NodePgDatabase<typeof dbSchema> | null): FundingSinkPort {
  return isTestEnv() || db === null ? new InMemoryFundingSink() : new FundingEventsRepository(db);
}

const DEFAULT_PAPER_CONFIG: PaperConfig = {
  seed: 1,
  takerBuffer: '0.05',
  // Spot's own row of the shared fee table (see buildPaperPerpConfig for why this indirection
  // exists). This is the spot-rail default; the perp rail builds its own config per descriptor.
  fees: { ...spotPaperFees(), feeCurrency: 'quote' },
  latency: { submitMs: [0, 0], eventMs: [0, 0] },
  insufficientDepthPolicy: 'partial_then_reject_rest',
  startingBalances: { USDT: '100000' }, // overridden per-venue in buildExchangePortFor
};

@Global()
@Module({
  // v3-final(#5b): ExecutionModule for EXEC_OUTBOX/EXEC_REPORT_NOTIFY (VENUE_EXCHANGE_PORTS' own
  // factory injects both) — ExecutionModule is not @Global, so every consumer of its exports must
  // import it directly (same requirement PaperExchangeModule's own retired `imports: [ExecutionModule]`
  // satisfied for the pre-v3 single-venue EXCHANGE_PORT factory).
  imports: [ExecutionModule, PersistenceModule],
  providers: [
    { provide: PAPER_CONFIG, useValue: DEFAULT_PAPER_CONFIG },
    {
      provide: FUNDING_SINK,
      useFactory: buildFundingSink,
      inject: [DRIZZLE_DB],
    },
    {
      provide: VENUE_EXCHANGE_PORTS,
      useFactory: buildVenueExchangePorts,
      inject: [
        VENUE_REGISTRY,
        TypedConfigService,
        CLOCK,
        EXEC_OUTBOX,
        EXEC_REPORT_NOTIFY,
        PAPER_CONFIG,
        FUNDING_SINK,
      ],
    },
    {
      provide: EXCHANGE_PORT,
      useFactory: (ports: ReadonlyMap<VenueId, ExchangePort>): ExchangePort =>
        new VenueRoutingExchangeAdapter(ports),
      inject: [VENUE_EXCHANGE_PORTS],
    },
  ],
  exports: [PAPER_CONFIG, VENUE_EXCHANGE_PORTS, EXCHANGE_PORT],
})
export class ExchangeAdaptersModule {}
