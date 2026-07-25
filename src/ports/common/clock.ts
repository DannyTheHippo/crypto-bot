import type { EpochMs } from '../../domain/common/types/ids';

export const CLOCK = Symbol('CLOCK');

export interface ClockPort {
  now(): EpochMs;
}

export class SystemClock implements ClockPort {
  now(): EpochMs {
    return Date.now() as EpochMs;
  }
}
