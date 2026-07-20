import { Global, Module } from '@nestjs/common';
import Decimal from 'decimal.js';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import type { VenueConfig, VenueEnvironment } from '../../../ports/app-config';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { LIVE_ADAPTER_CAP } from '../../../ports/mode-control';
import {
  EXEC_OUTBOX,
  EXEC_REPORT_NOTIFY,
  type ExecOutboxPort,
  type ExecReportNotify,
} from '../../../ports/execution';
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
} from '../../../ports/exchange';
import type { ClientOrderId, SymbolId, EpochMs } from '../../../domain/types/ids';
import { venueId, type VenueId } from '../../../domain/types/ids';
import { venueForSymbol, PERP_VENUE } from '../../../domain/types/venue-map';
import { assertSwapPrivateUrlSafe } from '../../../shared/venue-safety/swap-url-guard';
import { buildCcxtExchange } from '../market-data/ccxt-stream.adapter';
import { RealCcxtOrderClient } from '../exchange/ccxt-order-client';
import { CcxtExchangeAdapter } from '../exchange/ccxt-exchange.adapter';
import { LiveExchangeAdapter } from '../exchange/live-exchange.adapter';
import {
  PaperExchangeAdapter,
  PAPER_CONFIG,
  type PaperConfig,
} from '../exchange/paper-exchange.adapter';
import {
  PaperPerpAdapter,
  FUNDING_SINK,
  type PaperPerpConfig,
  type FundingSinkPort,
} from '../exchange/paper-perp.adapter';
// v3-integration(#6): in-memory-funding-sink.ts is on the §9 deletion list ("funding payments are
// DB-mandatory") but no DB-backed writer for the funding_events table (PaperPerpAdapter's OWN
// funding-simulation journal, distinct from the funding_payments venue-ingest table §6 already owns)
// exists yet. Binding the in-memory sink here is a deliberate stopgap — flag for #6/#8 to land a
// Drizzle-backed FundingSinkPort and delete this import in the same pass as the file's removal.
import { InMemoryFundingSink } from '../exchange/in-memory-funding-sink';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';

// v3 spec §1.3: ExchangeAdaptersModule replaces PaperExchangeModule. VENUE_EXCHANGE_PORTS (token
// defined in ports/exchange.ts — see that file for why) holds one concrete ExchangePort per registry
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
  return {
    seed: 1,
    fees: { makerBps: '10', takerBps: '10' },
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

const DEFAULT_PAPER_CONFIG: PaperConfig = {
  seed: 1,
  takerBuffer: '0.05',
  fees: { makerBps: '10', takerBps: '10', feeCurrency: 'quote' },
  latency: { submitMs: [0, 0], eventMs: [0, 0] },
  insufficientDepthPolicy: 'partial_then_reject_rest',
  startingBalances: { USDT: '100000' }, // overridden per-venue in buildExchangePortFor
};

@Global()
@Module({
  providers: [
    { provide: PAPER_CONFIG, useValue: DEFAULT_PAPER_CONFIG },
    {
      // Stopgap FUNDING_SINK binding — see the InMemoryFundingSink import comment above.
      provide: FUNDING_SINK,
      useFactory: (): FundingSinkPort => new InMemoryFundingSink(),
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
