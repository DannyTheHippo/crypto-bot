import { Injectable } from '@nestjs/common';
import type { PlanStop, PlanStopRegistryPort } from '../../../ports/risk';

// Trivial Map-backed impl of PlanStopRegistryPort (ports/risk.ts) — a single shared instance bridges
// AgenticStrategy (writer, on plan-entry-fill/clear) and ProtectiveExitService (reader, each 1s tick).
// See ports/risk.ts's own header comment for the key convention and venueStopResting's future-proofing.
@Injectable()
export class PlanStopRegistryService implements PlanStopRegistryPort {
  private readonly stops = new Map<string, PlanStop>();

  set(key: string, stop: PlanStop): void {
    this.stops.set(key, stop);
  }

  clear(key: string): void {
    this.stops.delete(key);
  }

  get(key: string): PlanStop | undefined {
    return this.stops.get(key);
  }

  entries(): ReadonlyMap<string, PlanStop> {
    return this.stops;
  }
}
