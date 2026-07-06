import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER, currentCorrelationId, runWithCorrelation } from './correlation';

// Propagates (or mints) the x-correlation-id for every HTTP request: the inbound header is trusted
// as an opaque id (echoed back on the response so a caller can stitch client and server logs), and
// the handler chain runs inside the ALS scope so the pino mixin stamps every line it logs.
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const raw = req.headers[CORRELATION_HEADER];
    const inbound = Array.isArray(raw) ? raw[0] : raw;
    runWithCorrelation(inbound, () => {
      res.setHeader(CORRELATION_HEADER, currentCorrelationId()!);
      next();
    });
  }
}
