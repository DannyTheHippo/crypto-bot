// Edge-tournament foundation tests — deterministic fixtures only; no outcome datasets.
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  alignDailyTimestamps,
  assertNoSameBarFill,
  ohlcvToDailySeries,
  rollingNewsZ,
  tradingCalendarTimestamps,
} from './alignment';
import { loadMacroEventsFromJson, macroExposureScale } from './calculators/xsec20-volbeta-macro';
import {
  ELIGIBILITY_LOOKBACK_DAYS,
  FUNDING_STABILITY_SETTLEMENTS,
  REPORTING_SEGMENTS,
  TRIAL_IDS,
  UNIVERSE_BASE,
  toBinanceUsdmSymbol,
} from './constants';
import {
  crossVenueEpisodeCostUsd,
  directionalLegCostUsd,
  llmConsultCostUsd,
  notionalFromWeight,
} from './costs';
import { eligibleAtBar, trailingReturn } from './eligibility';
import {
  appendFutureBar,
  fixtureDailyMap,
  fixtureFundingVenueSeries,
  fixtureNews,
  fixtureNewsExtreme,
  makeDailyBars,
} from './fixtures/synthetic';
import {
  alignFundingRows,
  fundingSign,
  optimalOrderedPair,
  pairsEqual,
  runFundingDispersion3d,
  runNews1dAsymmetric,
  runResidual20Volbeta,
  runXsec20Ew,
  runXsec20Volbeta,
} from './index';
import {
  buildDatasetEntry,
  manifestHash,
  sha256Hex,
  type EdgeTournamentManifest,
} from './manifest';
import { medianSegmentNetBps } from './metrics';
import { scorecardPath } from './scorecard';
import type { TrialResult } from './types';
import { evaluateWinnerGate, pickWinner, rankWinners } from './winner-gate';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

describe('edge-tournament foundation', () => {
  it('freezes the 16-perp universe and three chronological segments', () => {
    expect(UNIVERSE_BASE).toHaveLength(16);
    expect(TRIAL_IDS).toHaveLength(6);
    expect(REPORTING_SEGMENTS).toHaveLength(3);
    expect(REPORTING_SEGMENTS[0]!.startMs).toBeLessThan(REPORTING_SEGMENTS[1]!.startMs);
    expect(REPORTING_SEGMENTS[1]!.endMs).toBe(REPORTING_SEGMENTS[2]!.startMs);
  });

  it('aligns daily timestamps across symbols without lookahead gaps', () => {
    const map = fixtureDailyMap(120);
    const ts = alignDailyTimestamps(map);
    expect(ts.length).toBe(120);
    expect(() => assertNoSameBarFill(10, 11)).not.toThrow();
    expect(() => assertNoSameBarFill(10, 10)).toThrow(/lookahead/);
  });

  it('trading calendar uses BTC axis so short listings do not truncate history', () => {
    const map = fixtureDailyMap(200);
    const short = makeDailyBars(Date.parse('2024-06-01T00:00:00.000Z'), 50, 10, 0.001);
    map.set('HYPE/USDT:USDT', ohlcvToDailySeries('HYPE/USDT:USDT', short));
    const cal = tradingCalendarTimestamps(map);
    expect(cal.length).toBe(200);
    expect(alignDailyTimestamps(map).length).toBeLessThan(cal.length);
  });

  it('enforces 90-observation eligibility', () => {
    const bars = makeDailyBars(Date.parse('2024-01-01T00:00:00.000Z'), 100, 100, 0.001);
    const series = ohlcvToDailySeries('BTC/USDT:USDT', bars);
    expect(eligibleAtBar(series, ELIGIBILITY_LOOKBACK_DAYS - 1)).toBe(false);
    expect(eligibleAtBar(series, ELIGIBILITY_LOOKBACK_DAYS)).toBe(true);
    expect(trailingReturn(series.closes, 50, 20)).not.toBeNull();
    expect(trailingReturn(series.closes, 15, 20)).toBeNull();
  });

  it('joins news strictly backward (no lookahead)', () => {
    const start = Date.parse('2024-06-01T00:00:00.000Z');
    const news = fixtureNews(start, 100);
    const zBefore = rollingNewsZ(news, start + 95 * 86_400_000, 90);
    expect(zBefore).not.toBeNull();
    const futureSensitive = rollingNewsZ(news, start, 90);
    expect(futureSensitive).toBeNull();
  });

  it('computes exact-string directional and cross-venue costs', () => {
    const n = notionalFromWeight('0.10');
    const leg = directionalLegCostUsd(n);
    expect(leg.toFixed()).toBe('0.15');
    const ep = crossVenueEpisodeCostUsd('binanceusdm', 'bybit', n);
    expect(ep.gt(0)).toBe(true);
    expect(llmConsultCostUsd(null).toFixed()).toBe('0.03');
    expect(llmConsultCostUsd('0.05').toFixed()).toBe('0.05');
  });

  it('stable funding pair selection and sign convention', () => {
    const pair = optimalOrderedPair({
      binanceusdm: '0.0001',
      bybit: '0.0003',
      okx: '0.0002',
    });
    expect(pair).toEqual({ longVenue: 'binanceusdm', shortVenue: 'bybit' });
    expect(pairsEqual(pair, { longVenue: 'binanceusdm', shortVenue: 'bybit' })).toBe(true);
    expect(fundingSign(true, '0.0001')).toBe('pay');
    expect(fundingSign(false, '0.0001')).toBe('receive');
  });

  it('requires three stable settlements before funding entry', () => {
    const start = Date.parse('2024-01-01T00:00:00.000Z');
    const symbol = 'BTC/USDT:USDT';
    const series = [
      fixtureFundingVenueSeries('binanceusdm', symbol, start, 6, '0.00005'),
      fixtureFundingVenueSeries('bybit', symbol, start, 6, '0.00015'),
      fixtureFundingVenueSeries('okx', symbol, start, 6, '0.00010'),
    ];
    const aligned = alignFundingRows(series);
    expect(aligned.length).toBeGreaterThanOrEqual(FUNDING_STABILITY_SETTLEMENTS);
    const result = runFundingDispersion3d({ symbol, venueSeries: series });
    expect(result.trialId).toBe('funding-dispersion-3d');
    expect(Number.isFinite(Number(result.aggregateNetPnlUsd))).toBe(true);
  });

  it('aligns funding settlements across sub-second venue timestamp drift', () => {
    const start = Date.parse('2024-01-01T00:00:00.000Z');
    const symbol = 'BTC/USDT:USDT';
    const binance = fixtureFundingVenueSeries('binanceusdm', symbol, start, 4, '0.00005');
    const bybit = fixtureFundingVenueSeries('bybit', symbol, start, 4, '0.00015');
    // Simulate Binance ...001Z drift on every stamp.
    const drifted = {
      ...binance,
      settlements: binance.settlements.map((r) => ({
        ...r,
        timestamp: r.timestamp + 1,
      })),
    };
    const aligned = alignFundingRows([drifted, bybit]);
    expect(aligned.length).toBe(4);
    expect(aligned.every((row) => row.rates.binanceusdm && row.rates.bybit)).toBe(true);
  });

  it('vol-beta weights differ from equal-weight xsec trial on fixture data', () => {
    const map = fixtureDailyMap(130);
    const ew = runXsec20Ew(map);
    const vb = runXsec20Volbeta(map);
    const resid = runResidual20Volbeta(map);
    expect(ew.trialId).toBe('xsec20-ew');
    expect(vb.trialId).toBe('xsec20-volbeta');
    expect(resid.trialId).toBe('residual20-volbeta');
    expect(ew.avgGrossExposureFraction).not.toBe('');
  });

  it('news1d asymmetric fires deterministic BTC/ETH positions', () => {
    const map = fixtureDailyMap(130);
    const btc = map.get('BTC/USDT:USDT')!;
    const eth = map.get('ETH/USDT:USDT')!;
    const news = fixtureNewsExtreme(Date.parse('2024-01-01T00:00:00.000Z'), 130);
    const result = runNews1dAsymmetric({ btc, eth, news });
    expect(result.trialId).toBe('news1d-asymmetric');
    expect(result.cycles).toBeGreaterThan(0);
  });

  it('macro trial scales exposure around FOMC/CPI events', () => {
    const events = loadMacroEventsFromJson([
      { name: 'US CPI (test)', atMs: Date.parse('2024-03-01T12:00:00.000Z') },
    ]);
    const ts = Date.parse('2024-03-01T12:00:00.000Z');
    expect(macroExposureScale(ts, events)).toBe('0');
    expect(macroExposureScale(ts + 3 * 3_600_000, events)).toBe('0.50');
    expect(macroExposureScale(ts + 72 * 3_600_000, events)).toBe('1');
  });

  it('manifest hash is stable for identical dataset metadata', () => {
    const entry = buildDatasetEntry({
      id: 'ohlcv-btc-1d',
      url: 'https://api.binance.com/api/v3/klines',
      requestParams: { symbol: 'BTCUSDT', interval: '1d' },
      rangeStartMs: 1,
      rangeEndMs: 2,
      rowCount: 10,
      cachePath: '/tmp/absent.json',
      contentSha256: sha256Hex('fixture'),
    });
    const manifest: EdgeTournamentManifest = {
      version: 1,
      frozenAt: '2026-07-24',
      preregReport: 'research/studies/edge-tournament-preregistration-2026-07-24.md',
      datasets: [entry],
    };
    const h1 = manifestHash(manifest);
    const h2 = manifestHash(manifest);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('winner gate and deterministic tie-break', () => {
    const base: TrialResult = {
      trialId: 'xsec20-ew',
      aggregateNetPnlUsd: '50',
      aggregateNetBps: '500',
      cycles: 40,
      maxDrawdownFraction: '0.05',
      turnoverNotionalUsd: '800',
      avgGrossExposureFraction: '0.20',
      costs: {
        feesUsd: '10',
        slippageUsd: '5',
        fundingUsd: '0',
        llmUsd: '1',
        turnoverUsd: '0',
      },
      symbolPnlUsd: { 'BTC/USDT:USDT': '20', 'ETH/USDT:USDT': '20', 'SOL/USDT:USDT': '10' },
      segments: [
        {
          segmentId: 1,
          netPnlUsd: '20',
          netBps: '200',
          cycles: 10,
          maxDrawdownFraction: '0.02',
          turnoverNotionalUsd: '200',
          avgGrossExposureFraction: '0.2',
          costs: {
            feesUsd: '2',
            slippageUsd: '1',
            fundingUsd: '0',
            llmUsd: '0.2',
            turnoverUsd: '0',
          },
          symbolPnlUsd: {},
        },
        {
          segmentId: 2,
          netPnlUsd: '15',
          netBps: '150',
          cycles: 10,
          maxDrawdownFraction: '0.02',
          turnoverNotionalUsd: '200',
          avgGrossExposureFraction: '0.2',
          costs: {
            feesUsd: '2',
            slippageUsd: '1',
            fundingUsd: '0',
            llmUsd: '0.2',
            turnoverUsd: '0',
          },
          symbolPnlUsd: {},
        },
        {
          segmentId: 3,
          netPnlUsd: '15',
          netBps: '150',
          cycles: 10,
          maxDrawdownFraction: '0.02',
          turnoverNotionalUsd: '200',
          avgGrossExposureFraction: '0.2',
          costs: {
            feesUsd: '2',
            slippageUsd: '1',
            fundingUsd: '0',
            llmUsd: '0.2',
            turnoverUsd: '0',
          },
          symbolPnlUsd: {},
        },
      ],
      stress2xNetPnlUsd: '5',
    };
    const gate = evaluateWinnerGate({
      trial: base,
      flatBaselineNetPnlUsd: '0',
      agenticBaselineNetPnlUsd: '-10',
      dataProbesOk: true,
    });
    expect(gate.passes).toBe(true);
    expect(medianSegmentNetBps(base.segments)).toBe('150.0000');

    const a = {
      trialId: 'xsec20-ew' as const,
      gate: { passes: true, reasons: [], medianSegmentNetBps: '200' },
      trial: { ...base, maxDrawdownFraction: '0.04', turnoverNotionalUsd: '500' },
    };
    const b = {
      trialId: 'xsec20-volbeta' as const,
      gate: { passes: true, reasons: [], medianSegmentNetBps: '200' },
      trial: {
        ...base,
        trialId: 'xsec20-volbeta' as const,
        maxDrawdownFraction: '0.06',
        turnoverNotionalUsd: '700',
      },
    };
    const winner = pickWinner([b, a]);
    expect(winner?.trialId).toBe('xsec20-ew');
    expect(rankWinners([b, a])[0]?.trialId).toBe('xsec20-ew');
  });

  it('equity curve invariant when future bars appended (excl boundary)', () => {
    const map = fixtureDailyMap(100);
    const shortMap = new Map(map);
    const longMap = new Map(map);
    const sym = toBinanceUsdmSymbol('BTC');
    longMap.set(sym, appendFutureBar(map.get(sym)!, 10));
    const shortRun = runXsec20Ew(shortMap);
    const longRun = runXsec20Ew(longMap);
    expect(shortRun.equityCurve).toBeDefined();
    expect(longRun.equityCurve).toBeDefined();
    const shortCurve = shortRun.equityCurve!;
    const longCurve = longRun.equityCurve!;
    const n = Math.min(shortCurve.length, longCurve.length) - 1;
    for (let i = 0; i < n; i += 1) {
      expect(longCurve[i]!.equityUsd).toBe(shortCurve[i]!.equityUsd);
    }
  });

  it('scorecard writer path lives under research/candidates/', () => {
    expect(scorecardPath('xsec20-ew')).toMatch(
      /research\/candidates\/edge-tournament-xsec20-ew-2026-07-24\.json$/,
    );
  });
});
