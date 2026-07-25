import { readFileSync } from 'node:fs';
import type { AgentCalendarEvent } from '../../../ports/strategy/agentic-strategy';

// I1 (Design § Enriched model inputs): repo-maintained macro-event calendar
// (data/macro-calendar.json, seeded at I2) — FOMC/CPI/major scheduled events, published far ahead,
// refreshed monthly by the daily loop; zero external API. The loader is deliberately tolerant: a
// missing/empty/malformed file (or a malformed individual entry) is a WARN + that entry/file dropped,
// never a boot failure — this is a measurement/context feed, not a safety gate (fails OPEN, per
// code-hygiene's failure-direction rule). The next-72h window is NOT applied here — see
// filterUpcoming below, applied at render time so one loaded list serves many consults across a
// moving "now" without re-reading the file.

export interface MacroCalendarLoggerLike {
  warn(msg: string): void;
}

const NOOP_LOGGER: MacroCalendarLoggerLike = { warn: () => undefined };

function isCalendarEvent(entry: unknown): entry is AgentCalendarEvent {
  if (entry === null || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e['name'] === 'string' &&
    typeof e['atMs'] === 'number' &&
    Number.isFinite(e['atMs']) &&
    (e['importance'] === 'high' || e['importance'] === 'medium')
  );
}

export function loadMacroCalendar(
  filePath: string,
  logger: MacroCalendarLoggerLike = NOOP_LOGGER,
): readonly AgentCalendarEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn(
      `macro calendar: could not read ${filePath} (${err instanceof Error ? err.message : String(err)}) — proceeding with an empty calendar`,
    );
    return [];
  }

  let parsed: unknown;
  try {
    parsed = raw.trim().length === 0 ? [] : JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `macro calendar: ${filePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — proceeding with an empty calendar`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn(
      `macro calendar: ${filePath} did not parse to a JSON array — proceeding with an empty calendar`,
    );
    return [];
  }

  const events: AgentCalendarEvent[] = [];
  for (const entry of parsed) {
    if (isCalendarEvent(entry)) {
      events.push(entry);
    } else {
      logger.warn(
        `macro calendar: skipping malformed entry in ${filePath}: ${JSON.stringify(entry)}`,
      );
    }
  }
  return events;
}

// Next-72h window, applied at render time (Design § Enriched model inputs: "Payload renders next-72h
// events"). Exported so the composition root's boot log and the future payload renderer share ONE
// definition of "upcoming" — never two independently-drifting window computations.
export function filterUpcoming(
  events: readonly AgentCalendarEvent[],
  nowMs: number,
  windowMs = 72 * 60 * 60 * 1000,
): readonly AgentCalendarEvent[] {
  return events.filter((e) => e.atMs >= nowMs && e.atMs <= nowMs + windowMs);
}
