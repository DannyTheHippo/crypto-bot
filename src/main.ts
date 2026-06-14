import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { setupDecimal } from './domain';
import type { AppConfig } from './modules/config/app-config.schema';

async function bootstrap() {
  setupDecimal();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const configService = app.get(ConfigService<AppConfig, true>);
  const appCfg = configService.get('app', { infer: true });
  const port = appCfg.port;

  // Bind localhost by default (design §10: admin/arming API is localhost-only). In a container the
  // network namespace is the isolation boundary and Prometheus must reach /metrics via the service
  // IP, so compose sets HOST=0.0.0.0. Token+HMAC+bootId still gate the arming endpoints.
  await app.listen(port, process.env['HOST'] ?? '127.0.0.1');
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
