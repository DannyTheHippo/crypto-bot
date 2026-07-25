import { simulateXsec } from '../xsec-core';
import type { DailySeries, TrialResult } from '../types';

export function runXsec20Ew(bySymbol: ReadonlyMap<string, DailySeries>): TrialResult {
  return simulateXsec(bySymbol, {
    trialId: 'xsec20-ew',
    weightMode: 'equal',
    rankMode: 'raw',
  });
}

export function runXsec20Volbeta(bySymbol: ReadonlyMap<string, DailySeries>): TrialResult {
  return simulateXsec(bySymbol, {
    trialId: 'xsec20-volbeta',
    weightMode: 'volbeta',
    rankMode: 'raw',
  });
}

export function runResidual20Volbeta(bySymbol: ReadonlyMap<string, DailySeries>): TrialResult {
  return simulateXsec(bySymbol, {
    trialId: 'residual20-volbeta',
    weightMode: 'volbeta',
    rankMode: 'residual',
  });
}
