import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrialResult } from './types';
import type { WinnerGateResult } from './types';

/** Scorecard JSON path under candidates/ — writer only; no outcome scorecards yet. */
export function scorecardPath(trialId: string, asOfDate = '2026-07-24'): string {
  return join(process.cwd(), 'candidates', `edge-tournament-${trialId}-${asOfDate}.json`);
}

export interface EdgeTournamentScorecard {
  readonly kind: 'edge-tournament-scorecard';
  readonly trialId: string;
  readonly asOfDate: string;
  readonly preregReport: string;
  readonly result: TrialResult | null;
  readonly gate: WinnerGateResult | null;
  readonly note: string;
}

export function writeScorecard(
  trialId: string,
  payload: Omit<EdgeTournamentScorecard, 'kind' | 'trialId' | 'asOfDate'> & {
    asOfDate?: string;
  },
): string {
  const asOfDate = payload.asOfDate ?? '2026-07-24';
  const path = scorecardPath(trialId, asOfDate);
  const doc: EdgeTournamentScorecard = {
    kind: 'edge-tournament-scorecard',
    trialId,
    asOfDate,
    preregReport: payload.preregReport,
    result: payload.result,
    gate: payload.gate,
    note: payload.note,
  };
  mkdirSync(join(process.cwd(), 'candidates'), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}
