// One-shot edge-tournament runner — loads gitignored cache, runs six frozen trials, writes scorecards.
// Invoked via: pnpm run:edge-tournament  (or EDGE_TOURNAMENT_RUN=1 vitest run …)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ohlcvToDailySeries } from './alignment';
import {
  FUNDING_VENUES,
  GLOBAL_DISCOVERY_COUNT,
  MAX_TOURNAMENT_REAL_LLM_SPEND_USD,
  toBinanceUsdmSymbol,
  toSafeCacheName,
  UNIVERSE_BASE,
} from './constants';
import {
  loadMacroEventsFromJson,
  runFundingDispersion3d,
  runNews1dAsymmetric,
  runResidual20Volbeta,
  runXsec20Ew,
  runXsec20Volbeta,
  runXsec20VolbetaMacro,
} from './index';
import { CACHE_DIR, MANIFEST_PATH, readManifest, verifyManifestIntegrity } from './manifest';
import { writeScorecard } from './scorecard';
import type {
  DailySeries,
  NewsObservation,
  OhlcvBar,
  TrialResult,
  VenueFundingSeries,
  WinnerRankInput,
} from './types';
import { evaluateWinnerGate, pickWinner } from './winner-gate';

/** Flat baseline: do nothing on the $1k research book. */
export const FLAT_BASELINE_NET_PNL_USD = '0';

/**
 * Measured incumbent agentic baseline (demo scoreboard, net-of-cost) — negative.
 * Binding gate vs flat is still >0; this documents the incumbent comparison.
 * Source: reports/loop/LOG.md Pass ~33 era scoreboard (~−$23 on live demo book).
 */
export const AGENTIC_BASELINE_NET_PNL_USD = '-23.25';

const AS_OF = '2026-07-24';
const PREREG = 'reports/loop/edge-tournament-preregistration-2026-07-24.md';
const LEDGER = join(process.cwd(), 'candidates', 'edge-tournament-trials.jsonl');
const SUMMARY = join(process.cwd(), 'reports', 'loop', `edge-tournament-results-${AS_OF}.md`);

function loadOhlcvMap(): Map<string, DailySeries> {
  const out = new Map<string, DailySeries>();
  for (const base of UNIVERSE_BASE) {
    const symbol = toBinanceUsdmSymbol(base);
    const path = join(CACHE_DIR, `ohlcv-${toSafeCacheName(symbol)}-1d.json`);
    if (!existsSync(path)) continue;
    const bars = JSON.parse(readFileSync(path, 'utf8')) as OhlcvBar[];
    if (bars.length < 91) continue;
    out.set(symbol, ohlcvToDailySeries(symbol, bars));
  }
  return out;
}

function isValidNewsTs(n: { publishedMs?: unknown }): boolean {
  return typeof n.publishedMs === 'number' && Number.isFinite(n.publishedMs) && n.publishedMs > 0;
}

function loadNews(): { rows: NewsObservation[]; rawCount: number; invalidCount: number } {
  const path = join(CACHE_DIR, 'gdelt-crypto-news.json');
  if (!existsSync(path)) return { rows: [], rawCount: 0, invalidCount: 0 };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as NewsObservation[];
  const invalidCount = raw.filter((n) => !isValidNewsTs(n)).length;
  const rows = [...raw]
    .filter((n) => isValidNewsTs(n))
    .sort((a, b) => a.publishedMs - b.publishedMs);
  return { rows, rawCount: raw.length, invalidCount };
}

function loadFunding(symbol: string): VenueFundingSeries[] {
  const series: VenueFundingSeries[] = [];
  for (const venue of FUNDING_VENUES) {
    const path = join(CACHE_DIR, `funding-${venue}-${toSafeCacheName(symbol)}.json`);
    if (!existsSync(path)) continue;
    const settlements = JSON.parse(readFileSync(path, 'utf8')) as {
      timestamp: number;
      fundingRate: string;
    }[];
    series.push({ venue, symbol, settlements });
  }
  return series;
}

function loadMacro(): ReturnType<typeof loadMacroEventsFromJson> {
  const path = join(
    process.cwd(),
    'test/backtest/edge-tournament/fixtures/macro-events-2023-2026.json',
  );
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { name: string; atMs: number }[];
  return loadMacroEventsFromJson(raw);
}

function appendLedger(row: Record<string, unknown>): void {
  mkdirSync(join(process.cwd(), 'candidates'), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
}

export interface TournamentOutcome {
  readonly results: readonly TrialResult[];
  readonly ranked: readonly WinnerRankInput[];
  readonly winner: WinnerRankInput | null;
  readonly dataProbes: Readonly<Record<string, boolean>>;
  readonly manifestErrors: readonly string[];
}

export function runEdgeTournament(): TournamentOutcome {
  // Real LLM spend for this run: $0 (deterministic calculators only). Cap: $2.
  void MAX_TOURNAMENT_REAL_LLM_SPEND_USD;
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `missing manifest at ${MANIFEST_PATH} — run: node scripts/fetch-edge-tournament-data.mjs --full`,
    );
  }
  const manifest = readManifest();
  const manifestErrors = manifest ? verifyManifestIntegrity(manifest) : ['manifest unreadable'];
  const bySymbol = loadOhlcvMap();
  const newsLoad = loadNews();
  const news = newsLoad.rows;
  const macro = loadMacro();
  const btc = bySymbol.get('BTC/USDT:USDT');
  const eth = bySymbol.get('ETH/USDT:USDT');
  const fundingBtc = loadFunding('BTC/USDT:USDT');

  const dataProbes: Record<string, boolean> = {
    ohlcv_universe_ge_8: bySymbol.size >= 8,
    btc_eth_present: Boolean(btc && eth),
    // Must use valid timestamps only — raw null publishedMs previously false-passed news_rows_ge_30.
    news_rows_ge_30: news.length >= 30,
    news_timestamps_valid: newsLoad.rawCount > 0 && newsLoad.invalidCount === 0,
    funding_venues_ge_2: fundingBtc.length >= 2,
    macro_events_ge_10: macro.length >= 10,
    manifest_ok: manifestErrors.length === 0,
  };

  const results: TrialResult[] = [];
  results.push(runXsec20Ew(bySymbol));
  results.push(runXsec20Volbeta(bySymbol));
  results.push(runResidual20Volbeta(bySymbol));
  if (btc && eth) {
    results.push(runNews1dAsymmetric({ btc, eth, news }));
  }
  if (fundingBtc.length >= 2) {
    results.push(runFundingDispersion3d({ symbol: 'BTC/USDT:USDT', venueSeries: fundingBtc }));
  }
  results.push(runXsec20VolbetaMacro(bySymbol, macro));

  const rankedInputs: WinnerRankInput[] = [];
  for (const trial of results) {
    const probeOk =
      dataProbes.ohlcv_universe_ge_8 &&
      dataProbes.manifest_ok &&
      (trial.trialId !== 'news1d-asymmetric' ||
        (dataProbes.news_rows_ge_30 && dataProbes.news_timestamps_valid)) &&
      (trial.trialId !== 'funding-dispersion-3d' || dataProbes.funding_venues_ge_2) &&
      (trial.trialId !== 'xsec20-volbeta-macro' || dataProbes.macro_events_ge_10);

    const gate = evaluateWinnerGate({
      trial,
      flatBaselineNetPnlUsd: FLAT_BASELINE_NET_PNL_USD,
      agenticBaselineNetPnlUsd: AGENTIC_BASELINE_NET_PNL_USD,
      dataProbesOk: Boolean(probeOk),
    });
    rankedInputs.push({ trialId: trial.trialId, gate, trial });
    writeScorecard(trial.trialId, {
      preregReport: PREREG,
      result: trial,
      gate,
      note: probeOk ? 'full probe pass path' : 'data probe failed for this trial family',
      asOfDate: AS_OF,
    });
    appendLedger({
      at: new Date().toISOString(),
      trialId: trial.trialId,
      aggregateNetPnlUsd: trial.aggregateNetPnlUsd,
      cycles: trial.cycles,
      maxDrawdownFraction: trial.maxDrawdownFraction,
      gatePasses: gate.passes,
      gateReasons: gate.reasons,
      discoveryN: GLOBAL_DISCOVERY_COUNT,
    });
  }

  const winner = pickWinner(rankedInputs);
  writeSummary(rankedInputs, winner, dataProbes, manifestErrors);
  return {
    results,
    ranked: rankedInputs,
    winner,
    dataProbes,
    manifestErrors,
  };
}

function writeSummary(
  ranked: readonly WinnerRankInput[],
  winner: WinnerRankInput | null,
  dataProbes: Readonly<Record<string, boolean>>,
  manifestErrors: readonly string[],
): void {
  const lines: string[] = [
    `# Edge tournament results (${AS_OF})`,
    '',
    `Preregistration: \`${PREREG}\``,
    `Discovery N (conservative): **${GLOBAL_DISCOVERY_COUNT}**`,
    `Flat baseline: \`${FLAT_BASELINE_NET_PNL_USD}\` · Agentic baseline: \`${AGENTIC_BASELINE_NET_PNL_USD}\``,
    `Real LLM spend this run: **$0** (deterministic calculators; hard cap \`${MAX_TOURNAMENT_REAL_LLM_SPEND_USD}\`)`,
    '',
    '## Data probes',
    '',
    ...Object.entries(dataProbes).map(([k, v]) => `- ${k}: ${v ? 'ok' : 'FAIL'}`),
    ...(manifestErrors.length
      ? ['', 'Manifest errors:', ...manifestErrors.map((e) => `- ${e}`)]
      : []),
    '',
    '## Trial scoreboard',
    '',
    '| Trial | Net PnL USD | Cycles | Max DD | Median seg bps | Gate |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const r of ranked) {
    lines.push(
      `| \`${r.trialId}\` | ${r.trial.aggregateNetPnlUsd} | ${r.trial.cycles} | ${r.trial.maxDrawdownFraction} | ${r.gate.medianSegmentNetBps} | ${r.gate.passes ? 'PASS' : 'fail'} |`,
    );
  }
  lines.push('', '## Winner');
  if (winner) {
    lines.push(
      '',
      `**\`${winner.trialId}\`** passed the demo-build gate.`,
      '',
      'Next: enable EdgePolicy for this family in demo only after Phase 4 wiring + adversarial review.',
    );
  } else {
    lines.push(
      '',
      '**No trial passed.** Production agentic behavior stays unchanged. Negative evidence is the result.',
      '',
      'Fail reasons:',
      '',
    );
    for (const r of ranked) {
      if (r.gate.passes) continue;
      lines.push(`- \`${r.trialId}\`: ${r.gate.reasons.join('; ') || 'unknown'}`);
    }
  }
  mkdirSync(join(process.cwd(), 'reports', 'loop'), { recursive: true });
  writeFileSync(SUMMARY, `${lines.join('\n')}\n`);
}

if (process.env.EDGE_TOURNAMENT_RUN === '1' && process.argv[1]?.includes('run-tournament')) {
  const out = runEdgeTournament();
  console.log(
    JSON.stringify(
      {
        winner: out.winner?.trialId ?? null,
        trials: out.ranked.map((r) => ({
          id: r.trialId,
          net: r.trial.aggregateNetPnlUsd,
          passes: r.gate.passes,
          reasons: r.gate.reasons,
        })),
      },
      null,
      2,
    ),
  );
}
