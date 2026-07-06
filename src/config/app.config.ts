import type { INestApplication } from '@nestjs/common';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { createSwaggerConfig } from './swagger.config';

// Template-mirror bootstrap assembly (CLAUDE.md P4). Health/metrics are infra-contract routes —
// the Dockerfile HEALTHCHECK hits /health/live and observability/prometheus.yml scrapes /metrics —
// so they are kept EXACT, unprefixed and unversioned, deliberately deviating from the template's
// plain `enableVersioning({ defaultVersion: '1' })` (which would rewrite every unversioned route,
// including the prometheus module's own internal MetricsController, to /v1/...). Versioning is
// therefore enabled WITHOUT a defaultVersion: only controllers that opt in with @Version('1') move
// under the versioned+prefixed surface (the arming controller); everything else keeps serving at its
// current bare path. See test/unit/observability/app-config.spec.ts for the routes this pins.
export function createApplicationConfig(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    exclude: ['health/live', 'health/ready', 'metrics'],
  });
  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();

  createSwaggerConfig(app);
}
