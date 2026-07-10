import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../ports/app-config';

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

  get agentic(): AppConfig['agentic'] {
    return this.config.get('agentic', { infer: true });
  }

  get risk(): AppConfig['risk'] {
    return this.config.get('risk', { infer: true });
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

  get sentimentFeed(): AppConfig['sentimentFeed'] {
    return this.config.get('sentimentFeed', { infer: true });
  }

  get observability(): AppConfig['observability'] {
    return this.config.get('observability', { infer: true });
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
}
