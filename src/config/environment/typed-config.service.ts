import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../ports/common/app-config';

// The template-mirror's single sanctioned config read path (see CLAUDE.md's config-facade rules).
// A thin typed facade over ConfigService<AppConfig, true> — one getter per AppConfig top-level key,
// each a direct config.get(key, { infer: true }) passthrough. No caching, no derived logic: callers
// that need derived values (e.g. limitsFor's RISK_* overlay) keep doing that derivation themselves,
// just off this facade's `risk` getter instead of a raw ConfigService injection. Raw ConfigService
// injection is legacy — new call sites should inject TypedConfigService instead.
@Injectable()
export class TypedConfigService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  get app(): AppConfig['app'] {
    return this.config.get('app', { infer: true });
  }

  get mode(): AppConfig['mode'] {
    return this.config.get('mode', { infer: true });
  }

  get db(): AppConfig['db'] {
    return this.config.get('db', { infer: true });
  }

  get venues(): AppConfig['venues'] {
    return this.config.get('venues', { infer: true });
  }

  // v3 §3.1: fixed wallet split of the one book (VENUE_CAPITAL_SPLIT), keyed by venue id.
  get venueCapitalSplit(): AppConfig['venueCapitalSplit'] {
    return this.config.get('venueCapitalSplit', { infer: true });
  }

  get agentic(): AppConfig['agentic'] {
    return this.config.get('agentic', { infer: true });
  }

  get risk(): AppConfig['risk'] {
    return this.config.get('risk', { infer: true });
  }

  get recovery(): AppConfig['recovery'] {
    return this.config.get('recovery', { infer: true });
  }

  get perp(): AppConfig['perp'] {
    return this.config.get('perp', { infer: true });
  }

  get strategy(): AppConfig['strategy'] {
    return this.config.get('strategy', { infer: true });
  }

  get derivativesFeed(): AppConfig['derivativesFeed'] {
    return this.config.get('derivativesFeed', { infer: true });
  }

  get fundingIngest(): AppConfig['fundingIngest'] {
    return this.config.get('fundingIngest', { infer: true });
  }

  get sentimentFeed(): AppConfig['sentimentFeed'] {
    return this.config.get('sentimentFeed', { infer: true });
  }

  get fearGreedFeed(): AppConfig['fearGreedFeed'] {
    return this.config.get('fearGreedFeed', { infer: true });
  }

  get tradeFlowFeed(): AppConfig['tradeFlowFeed'] {
    return this.config.get('tradeFlowFeed', { infer: true });
  }

  get positioningFeed(): AppConfig['positioningFeed'] {
    return this.config.get('positioningFeed', { infer: true });
  }

  get liquidationFeed(): AppConfig['liquidationFeed'] {
    return this.config.get('liquidationFeed', { infer: true });
  }

  get marketData(): AppConfig['marketData'] {
    return this.config.get('marketData', { infer: true });
  }

  get observability(): AppConfig['observability'] {
    return this.config.get('observability', { infer: true });
  }

  get configHash(): AppConfig['configHash'] {
    return this.config.get('configHash', { infer: true });
  }

  // §10 live-mode secrets, grouped: present only outside test/ci (the schema strips them otherwise).
  // Read solely inside the live-adapter factory + ModeControl at the composition root; never logged.
  get liveSecrets(): {
    liveApiKey: string | undefined;
    liveApiSecret: string | undefined;
    armingSecret: string | undefined;
    liveBaseUrlOverride: string | undefined;
  } {
    return {
      liveApiKey: this.config.get('liveApiKey', { infer: true }),
      liveApiSecret: this.config.get('liveApiSecret', { infer: true }),
      armingSecret: this.config.get('armingSecret', { infer: true }),
      liveBaseUrlOverride: this.config.get('liveBaseUrlOverride', { infer: true }),
    };
  }

  // The one deliberate exception to "one getter per key" above: the config-snapshot writer
  // (trading-runtime.module.ts's configSnapshotPayload) needs the WHOLE validated AppConfig, not a
  // single key, to build environment.config.ts's canonicalObjectWithoutSecrets projection — the same
  // filter that produces configHash's own canonical input, so the stored snapshot excludes exactly
  // what the hash excludes. Assembled entirely from this facade's own getters, never a raw
  // ConfigService passthrough, so it stays subject to the same test/ci live-secret stripping every
  // getter above already relies on.
  get raw(): AppConfig {
    return {
      app: this.app,
      mode: this.mode,
      db: this.db,
      venues: this.venues,
      venueCapitalSplit: this.venueCapitalSplit,
      agentic: this.agentic,
      risk: this.risk,
      recovery: this.recovery,
      perp: this.perp,
      strategy: this.strategy,
      derivativesFeed: this.derivativesFeed,
      fundingIngest: this.fundingIngest,
      sentimentFeed: this.sentimentFeed,
      fearGreedFeed: this.fearGreedFeed,
      tradeFlowFeed: this.tradeFlowFeed,
      positioningFeed: this.positioningFeed,
      liquidationFeed: this.liquidationFeed,
      marketData: this.marketData,
      observability: this.observability,
      configHash: this.configHash,
      ...this.liveSecrets,
    };
  }
}
