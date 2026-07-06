import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

// Template-mirror catch-all (CLAUDE.md P4). Stack/cause are attached to the response body only
// outside production-like environments — the deployed container sets NODE_ENV=production
// (docker-compose.yml), so a real boot never leaks a stack trace to an HTTP client; test/ci (no
// NODE_ENV=production) sees it for debuggability. Logging goes through Nest's own Logger (nestjs-pino
// wired at the composition root, main.ts) rather than console — never logs secrets (rule 7); this
// filter only logs the exception's own message/stack, never request bodies.
@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const body: Record<string, unknown> =
      typeof message === 'string' ? { statusCode: status, message } : { ...message };

    const isProdLike = process.env['NODE_ENV'] === 'production';
    if (!isProdLike && exception instanceof Error) {
      body['stack'] = exception.stack;
      if (exception.cause instanceof Error) {
        body['cause'] = { message: exception.cause.message, stack: exception.cause.stack };
      }
    }

    this.logger.error(exception instanceof Error ? exception.message : String(exception));

    const response = host.switchToHttp().getResponse<Response>();
    response.status(status).json(body);
  }
}
