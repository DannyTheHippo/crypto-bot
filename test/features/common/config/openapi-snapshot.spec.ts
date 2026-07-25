import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../../../../src/app.module';
import { buildOpenApiDocument } from '../../../../src/config/swagger.config';

// ONE AppModule instantiation per file (prom-client is a process-global singleton — see
// test/unit/execution/app-module.boot.spec.ts's header comment). This spec needs the real DI graph
// (controllers determine the routes the document serializes) so it owns its own file rather than
// sharing app-module.boot.spec.ts's compile.
//
// Freshness gate: the committed root openapi.json must match what buildOpenApiDocument() emits off
// the CURRENT controller/DTO graph. Regenerate it with `pnpm run openapi:write` (OPENAPI_WRITE=1),
// which writes the file instead of comparing, then commit the diff.
const OPENAPI_PATH = join(process.cwd(), 'openapi.json');

describe('OpenAPI document', () => {
  it('matches the committed openapi.json (or regenerates it under OPENAPI_WRITE=1)', async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app: INestApplication = ref.createNestApplication();
    await app.init();

    try {
      const document = buildOpenApiDocument(app);

      if (process.env['OPENAPI_WRITE'] === '1') {
        writeFileSync(OPENAPI_PATH, `${JSON.stringify(document, null, 2)}\n`);
        return;
      }

      const committed: unknown = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
      expect(document).toEqual(committed);
    } finally {
      await app.close();
    }
  });
});
