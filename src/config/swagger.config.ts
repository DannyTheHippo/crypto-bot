import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';

const logger = new Logger('SwaggerConfig');

// Template-mirror docs mount (CLAUDE.md P4). openapi.json is written to disk only under
// NODE_ENV=local — never in the deployed container (docker-compose sets NODE_ENV=production) and
// never under test/ci, keeping the hermetic suite and the demo boot free of a generated artifact.
export function createSwaggerConfig(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setVersion('0.0.1')
      .setTitle('crypto-bot API')
      .setDescription('crypto-bot arming/mode-control API specification')
      .build(),
  );

  SwaggerModule.setup('docs', app, document);

  if (process.env['NODE_ENV'] === 'local') {
    try {
      writeFileSync('openapi.json', JSON.stringify(document, null, 2));
    } catch (error: unknown) {
      logger.error('Failed to write openapi.json:', error);
    }
  }
}
