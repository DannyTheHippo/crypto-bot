import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { OpsEvent, OpsEventPort } from '../../../ports/observability';

// Backlog #52 (W12 operational event logging) — decision record.
// SCOPE: execution-lane diagnostic events (reconcile passes, kill-switch transitions, halt episodes,
// boot readiness) — see OpsEvent's own header comment (ports/observability.ts). The boot/arm/mode/
// disarm/downgrade lifecycle stays on ModeAuditEvent → audit_log (ports/mode-control.ts,
// DrizzleModeAudit); this helper never touches that surface.
// WHY PINO, NOT A NEW TABLE: every event here already exists as a Prometheus counter/gauge — this
// adds a structured, queryable LOG surface for correlation/search, not a second source of truth.
// Reusing the existing pino pipeline (logger.config.ts: base bootId/mode, correlationId mixin,
// REDACT_PATHS) gets that for free with zero new schema/migration/retention surface, unlike
// audit_log's append-only hash-chain (overkill for a diagnostic side-channel).
// FAIL OPEN: emit() is a measurement/diagnostic side-channel, never a control-flow input — a throw
// here (misconfigured logger, serialization failure) must never propagate into the execution/risk
// path that called it (code-hygiene.md's failure-direction declaration).
@Injectable()
export class OpsEventLogger implements OpsEventPort {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(OpsEventLogger.name);
  }

  emit(event: OpsEvent): void {
    try {
      this.logger.info({ ...event });
    } catch {
      /* fail OPEN — see this file's header comment */
    }
  }
}
