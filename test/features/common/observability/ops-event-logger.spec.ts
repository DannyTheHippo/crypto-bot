import { describe, it, expect } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import { OpsEventLogger } from '../../../../src/features/common/observability/ops-event-logger';
import type { OpsEvent } from '../../../../src/ports/common/observability';

function fakeLogger(): { logger: PinoLogger; lines: unknown[] } {
  const lines: unknown[] = [];
  const logger = {
    setContext: () => undefined,
    info: (obj: unknown) => {
      lines.push(obj);
    },
  } as unknown as PinoLogger;
  return { logger, lines };
}

describe('OpsEventLogger', () => {
  it('emit logs the structured {event, ...fields} shape on the injected logger', () => {
    const { logger, lines } = fakeLogger();
    const opsEvents = new OpsEventLogger(logger);
    const event: OpsEvent = {
      event: 'reconcile.pass',
      result: 'mismatch',
      mismatchClasses: ['balance_drift'],
      venue: 'binance',
    };
    opsEvents.emit(event);
    expect(lines).toEqual([event]);
  });

  // Fail OPEN (see ops-event-logger.ts's own header comment): emit() is a measurement/diagnostic
  // side-channel, never a control-flow input — a throwing logger must never propagate out of it.
  it('a throwing logger never propagates out of emit() (fail OPEN)', () => {
    const throwingLogger = {
      setContext: () => undefined,
      info: () => {
        throw new Error('boom');
      },
    } as unknown as PinoLogger;
    const opsEvents = new OpsEventLogger(throwingLogger);
    expect(() =>
      opsEvents.emit({ event: 'halt.cancels_drained', durationMs: 1_500, to: 'HALTED' }),
    ).not.toThrow();
  });

  // The helper is a thin pass-through (no extra fields injected) — every field it ever logs is one
  // of OpsEvent's own name/enum/id members, never a raw payload the caller could smuggle a secret
  // through. Exercises every union member to catch a future variant introducing an unexpected field.
  it('adds no fields beyond the given event for every OpsEvent variant', () => {
    const { logger, lines } = fakeLogger();
    const opsEvents = new OpsEventLogger(logger);
    const events: OpsEvent[] = [
      { event: 'reconcile.pass', result: 'clean', mismatchClasses: [], venue: 'binance' },
      { event: 'killswitch.transition', from: 'RUNNING', to: 'HALTING', reason: 'drawdown' },
      { event: 'halt.engage', reason: 'drawdown' },
      { event: 'halt.cancels_drained', durationMs: 250, to: 'HALTED' },
      { event: 'boot.ready', bootId: 'boot-1', mode: 'paper', strategies: ['agentic-1'] },
    ];
    for (const event of events) opsEvents.emit(event);
    expect(lines).toEqual(events);
  });
});
