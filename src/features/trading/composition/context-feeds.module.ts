import { Global, Module, Logger } from '@nestjs/common';
import { binanceusdm as BinanceUsdmExchange, binance as BinanceSpotExchange } from 'ccxt';
import { pro as ccxtPro } from 'ccxt';
import { TypedConfigService } from '../../../config/environment/typed-config.service';
import { CLOCK, type ClockPort } from '../../../ports/clock';
import { symbolId, type SymbolId } from '../../../domain/types/ids';
import { splitSymbol } from '../../../domain/types/symbol';
import { PERP_VENUE, PERP_VENUE_ID, SPOT_VENUE } from '../../../domain/types/venue-map';
import { DERIVATIVES_FEED, type DerivativesFeedPort } from '../../../ports/derivatives-feed';
import { SENTIMENT_FEED, type SentimentFeedPort } from '../../../ports/sentiment-feed';
import { FEAR_GREED_FEED, type FearGreedFeedPort } from '../../../ports/fear-greed-feed';
import { TRADE_FLOW_FEED, type TradeFlowFeedPort } from '../../../ports/trade-flow-feed';
import { POSITIONING_FEED, type PositioningFeedPort } from '../../../ports/positioning-feed';
import { LIQUIDATION_FEED, type LiquidationFeedPort } from '../../../ports/liquidation-feed';
import { FUNDING_PAYMENTS, type FundingPaymentsPort } from '../../../ports/funding-payments';
import {
  DerivativesFeedService,
  type DerivativesRestSource,
} from '../market-data/derivatives-feed.service';
import {
  SentimentFeedService,
  type SentimentHttpSource,
} from '../market-data/sentiment-feed.service';
import {
  FearGreedFeedService,
  type FearGreedHttpSource,
} from '../market-data/fear-greed-feed.service';
import {
  TradeFlowFeedService,
  type TradeFlowRestSource,
} from '../market-data/trade-flow-feed.service';
import {
  PositioningFeedService,
  type PositioningRestSource,
} from '../market-data/positioning-feed.service';
import {
  LiquidationFeedService,
  type LiquidationWatchSource,
} from '../market-data/liquidation-feed.service';
import { FundingIngestService } from '../exchange/funding-ingest.service';
import { AgentMetricsRecorder } from '../../common/observability/agent-metrics-recorder.service';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { VENUE_REGISTRY, type VenueRuntimeDescriptor } from '../../../ports/venue-registry';
import { VENUE_EXCHANGE_PORTS, type ExchangePort } from '../../../ports/exchange';
import type { VenueId } from '../../../domain/types/ids';

// v3 spec §1.3: ContextFeedsModule is MarketFeedModule's poller half, moved out of app.module.ts.
// Every feed is constructed ONCE over whichever symbol subset its underlying market actually covers
// (not the full 40-symbol combined basket): derivatives/positioning/liquidation/funding-ingest are
// perp-only concepts (VENUE_REGISTRY's perp descriptor); trade-flow reads spot klines (the spot
// descriptor, minus the explicit HYPE/KAITO skip list below); sentiment/fear-greed are basket-wide
// news feeds and keep reading the full combined symbol list via basketCurrenciesFor.

// P5b: composition-root-only token (mirrors the retired MD_EXCHANGE's own local-symbol convention)
// — no port abstraction needed, the only consumer is AgenticBridgeModule's extras factory reading
// FundingIngestService.cumulativeAccrualQuote() directly. Moved verbatim from app.module.ts; exported
// (unlike the original local const) because AgenticBridgeModule lives in a separate file now.
export const FUNDING_INGEST = Symbol('FUNDING_INGEST');

function isTestEnv(): boolean {
  return (
    process.env['NODE_ENV'] === 'test' ||
    process.env['NODE_ENV'] === 'ci' ||
    Boolean(process.env['CI'])
  );
}

const NOOP_DERIVATIVES_FEED: DerivativesFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
const NOOP_SENTIMENT_FEED: SentimentFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
const NOOP_FEAR_GREED_FEED: FearGreedFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
const NOOP_TRADE_FLOW_FEED: TradeFlowFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
const NOOP_POSITIONING_FEED: PositioningFeedPort = {
  latest: () => null,
  lastSuccessfulPollAt: () => null,
  pollErrorCount: () => 0,
};
const NOOP_LIQUIDATION_FEED: LiquidationFeedPort = {
  latest: () => null,
  streamHealthy: () => false,
  reconnectCount: () => 0,
};

// v3: the stage-1 HYPE/KAITO fail-open residual (spot klines gap on these two perp-launched
// symbols) becomes an explicit skip list, derived at boot, rather than a silent per-call fail-open.
const TRADE_FLOW_SPOT_SKIP = new Set(['HYPE/USDT', 'KAITO/USDT']);

// X4 residual: derives the CryptoPanic `currencies` filter from the deployment's OWN traded basket —
// moved verbatim from app.module.ts.
function basketCurrenciesFor(symbols: readonly string[]): string {
  const bases = new Set<string>();
  for (const s of symbols) {
    try {
      bases.add(splitSymbol(symbolId(s)).base);
    } catch {
      // Unparseable symbol string — skip it for this filter rather than aborting the whole basket.
    }
  }
  return Array.from(bases).join(',');
}

function buildSentimentHttpSource(apiKey: string, symbols: readonly string[]): SentimentHttpSource {
  const currencies = basketCurrenciesFor(symbols);
  return {
    fetchPosts: async () => {
      const res = await fetch(
        `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${currencies}`,
      );
      if (!res.ok) throw new Error(`cryptopanic fetch failed: ${res.status}`);
      return await res.json();
    },
  };
}

function buildFearGreedHttpSource(): FearGreedHttpSource {
  return {
    fetchIndex: async () => {
      const res = await fetch('https://api.alternative.me/fng/?limit=8');
      if (!res.ok) throw new Error(`alternative.me fetch failed: ${res.status}`);
      return await res.json();
    },
  };
}

function buildDerivativesRestSource(): DerivativesRestSource {
  const perp = new BinanceUsdmExchange({ number: String, enableRateLimit: true });
  const spot = new BinanceSpotExchange({ number: String, enableRateLimit: true });
  return {
    fetchFundingRate: (symbol) => perp.fetchFundingRate(symbol),
    fetchOpenInterest: (symbol) => perp.fetchOpenInterest(symbol),
    fetchTicker: (symbol) => spot.fetchTicker(symbol),
    fetchFundingRateHistory: (symbol, limit) =>
      perp.fetchFundingRateHistory(symbol, undefined, limit),
  };
}

function buildTradeFlowRestSource(): TradeFlowRestSource {
  const exchange = new BinanceSpotExchange({ number: String, enableRateLimit: true });
  return {
    fetchRawKlines: (symbol, interval, limit) =>
      (
        exchange as unknown as {
          publicGetKlines: (params: Record<string, unknown>) => Promise<unknown[][]>;
        }
      ).publicGetKlines({ symbol, interval, limit }),
  };
}

function buildPositioningRestSource(): PositioningRestSource {
  const exchange = new BinanceUsdmExchange({ number: String, enableRateLimit: true });
  return {
    fetchRawLongShortRatio: (symbol, period, limit) =>
      (
        exchange as unknown as {
          fapiDataGetGlobalLongShortAccountRatio: (
            params: Record<string, unknown>,
          ) => Promise<unknown[]>;
        }
      ).fapiDataGetGlobalLongShortAccountRatio({ symbol, period, limit }) as Promise<
        Array<{
          readonly longAccount?: string | number;
          readonly shortAccount?: string | number;
          readonly longShortRatio?: string | number;
          readonly timestamp?: number;
        }>
      >,
    fetchRawTakerLongShortRatio: (symbol, period, limit) =>
      (
        exchange as unknown as {
          fapiDataGetTakerlongshortRatio: (params: Record<string, unknown>) => Promise<unknown[]>;
        }
      ).fapiDataGetTakerlongshortRatio({ symbol, period, limit }) as Promise<
        Array<{
          readonly buySellRatio?: string | number;
          readonly buyVol?: string | number;
          readonly sellVol?: string | number;
          readonly timestamp?: number;
        }>
      >,
  };
}

function buildLiquidationWatchSource(): LiquidationWatchSource {
  const exchange = new ccxtPro.binanceusdm({ number: String, enableRateLimit: true });
  return {
    watchLiquidationsForSymbols: (symbols) =>
      (
        exchange as unknown as {
          watchLiquidationsForSymbols: (symbols: readonly string[]) => Promise<unknown[]>;
        }
      ).watchLiquidationsForSymbols(symbols) as Promise<
        readonly {
          readonly symbol: string;
          readonly side: string;
          readonly quoteValue?: number;
          readonly contracts?: number;
          readonly price?: number;
          readonly timestamp?: number;
        }[]
      >,
  };
}

function descriptorFor(
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
  venue: string,
): VenueRuntimeDescriptor | undefined {
  return [...registry.values()].find((d) => d.venue === venue);
}

// Exported (pure, no I/O) so the symbol-partitioning rules above are unit-testable directly against
// a fake registry, without booting the feed services' network/DI wiring.
export function perpSymbols(registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>): SymbolId[] {
  return [...(descriptorFor(registry, PERP_VENUE)?.symbols ?? [])];
}

export function tradeFlowSymbols(
  registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
): SymbolId[] {
  return [...(descriptorFor(registry, SPOT_VENUE)?.symbols ?? [])].filter(
    (s) => !TRADE_FLOW_SPOT_SKIP.has(s),
  );
}

export function combinedSymbols(registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>): string[] {
  return [...registry.values()].flatMap((d) => d.symbols as readonly string[]);
}

@Global()
@Module({
  imports: [ObservabilityModule],
  providers: [
    {
      provide: DERIVATIVES_FEED,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
      ): DerivativesFeedPort => {
        const { enabled, pollIntervalMs } = config.derivativesFeed;
        if (isTestEnv() || !enabled) return NOOP_DERIVATIVES_FEED;
        const source = buildDerivativesRestSource();
        const service = new DerivativesFeedService(source, {
          symbols: perpSymbols(registry),
          pollIntervalMs,
          clock,
          logger: new Logger('DerivativesFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK, VENUE_REGISTRY],
    },
    {
      provide: SENTIMENT_FEED,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
      ): SentimentFeedPort => {
        const { enabled, pollIntervalMs } = config.sentimentFeed;
        const apiKey = process.env['SENTIMENT_FEED_API_KEY'];
        if (isTestEnv()) return NOOP_SENTIMENT_FEED;
        if (!enabled) {
          new Logger('SentimentFeedService').log(
            'sentiment feed disabled (SENTIMENT_FEED_ENABLED=false) — boot proceeding without it',
          );
          return NOOP_SENTIMENT_FEED;
        }
        if (!apiKey) {
          new Logger('SentimentFeedService').log(
            'sentiment feed enabled but SENTIMENT_FEED_API_KEY is unset — feed stays inert',
          );
          return NOOP_SENTIMENT_FEED;
        }
        const source = buildSentimentHttpSource(apiKey, combinedSymbols(registry));
        const service = new SentimentFeedService(source, {
          pollIntervalMs,
          clock,
          logger: new Logger('SentimentFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK, VENUE_REGISTRY],
    },
    {
      provide: FEAR_GREED_FEED,
      useFactory: (config: TypedConfigService, clock: ClockPort): FearGreedFeedPort => {
        const { enabled, pollIntervalMs } = config.fearGreedFeed;
        if (isTestEnv() || !enabled) return NOOP_FEAR_GREED_FEED;
        const source = buildFearGreedHttpSource();
        const service = new FearGreedFeedService(source, {
          pollIntervalMs,
          clock,
          logger: new Logger('FearGreedFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK],
    },
    {
      provide: TRADE_FLOW_FEED,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
      ): TradeFlowFeedPort => {
        const { enabled, pollIntervalMs } = config.tradeFlowFeed;
        if (isTestEnv() || !enabled) return NOOP_TRADE_FLOW_FEED;
        const source = buildTradeFlowRestSource();
        const service = new TradeFlowFeedService(source, {
          symbols: tradeFlowSymbols(registry),
          interval: config.strategy.interval,
          lookbackBars: 20,
          pollIntervalMs,
          clock,
          logger: new Logger('TradeFlowFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK, VENUE_REGISTRY],
    },
    {
      provide: POSITIONING_FEED,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
      ): PositioningFeedPort => {
        const { enabled, pollIntervalMs } = config.positioningFeed;
        if (isTestEnv() || !enabled) return NOOP_POSITIONING_FEED;
        const source = buildPositioningRestSource();
        const service = new PositioningFeedService(source, {
          symbols: perpSymbols(registry),
          ratioPeriod: '15m',
          pollIntervalMs,
          clock,
          logger: new Logger('PositioningFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK, VENUE_REGISTRY],
    },
    {
      provide: LIQUIDATION_FEED,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
      ): LiquidationFeedPort => {
        const { enabled } = config.liquidationFeed;
        if (isTestEnv() || !enabled) return NOOP_LIQUIDATION_FEED;
        const source = buildLiquidationWatchSource();
        const service = new LiquidationFeedService(source, {
          symbols: perpSymbols(registry),
          clock,
          logger: new Logger('LiquidationFeedService'),
        });
        service.start();
        return service;
      },
      inject: [TypedConfigService, CLOCK, VENUE_REGISTRY],
    },
    {
      // P5b/v3: perp funding-payment settlement ingestion, wired directly off the PERP venue's OWN
      // exchange port (never the EXCHANGE_PORT routing facade) — funding payments are an inherently
      // perp-only concept, and fetchFundingPayments dispatches by symbol on the facade anyway, so
      // reading it straight off VENUE_EXCHANGE_PORTS avoids an unnecessary facade indirection. Gated
      // by the feature flag AND the perp port actually implementing fetchFundingPayments (paper's
      // PaperPerpAdapter does not) AND FUNDING_PAYMENTS being DB-bound.
      provide: FUNDING_INGEST,
      useFactory: (
        config: TypedConfigService,
        clock: ClockPort,
        ports: ReadonlyMap<VenueId, ExchangePort>,
        registry: ReadonlyMap<VenueId, VenueRuntimeDescriptor>,
        fundingPayments: FundingPaymentsPort | undefined,
        recorder: AgentMetricsRecorder,
      ): FundingIngestService | undefined => {
        const { enabled, pollIntervalMs } = config.fundingIngest;
        const perpPort = ports.get(PERP_VENUE_ID);
        if (
          isTestEnv() ||
          !enabled ||
          perpPort === undefined ||
          perpPort.fetchFundingPayments === undefined ||
          fundingPayments === undefined
        ) {
          return undefined;
        }
        const service = new FundingIngestService(perpPort, fundingPayments, {
          symbols: perpSymbols(registry),
          mode: config.mode.configMode,
          pollIntervalMs,
          clock,
          logger: new Logger('FundingIngestService'),
          metrics: {
            recordIngested: (venue, symbol, count) =>
              recorder.recordFundingIngested(venue, symbol, count),
          },
        });
        service.start();
        return service;
      },
      inject: [
        TypedConfigService,
        CLOCK,
        VENUE_EXCHANGE_PORTS,
        VENUE_REGISTRY,
        FUNDING_PAYMENTS,
        AgentMetricsRecorder,
      ],
    },
  ],
  exports: [
    DERIVATIVES_FEED,
    SENTIMENT_FEED,
    FEAR_GREED_FEED,
    TRADE_FLOW_FEED,
    POSITIONING_FEED,
    LIQUIDATION_FEED,
    FUNDING_INGEST,
  ],
})
export class ContextFeedsModule {}
