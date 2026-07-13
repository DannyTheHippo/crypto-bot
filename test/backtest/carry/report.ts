// Funding-carry study report renderer — RESEARCH TOOLING (test/backtest/, off the production gate).
//
// Pure formatting: takes the already-computed per-cell grid + deflation-benchmark numbers and renders
// the markdown for reports/loop/carry-study-2026-07-10.md. Table style mirrors
// reports/loop/edge-diagnostic-2026-07-10.md (unpadded pipes, DSR in exponential notation) — known-good
// against this repo's markdownlint-cli2 config.
import type { GateResult } from '../stats';
import type { CarryCellResult } from './carry-grid';

export interface CarryReportRow {
  readonly result: CarryCellResult;
  readonly gate: GateResult;
  readonly go: boolean;
}

export interface CarryReportData {
  readonly rows: readonly CarryReportRow[];
  readonly N: number;
  readonly priorCount: number;
  readonly priorSrMin: number;
  readonly priorSrMax: number;
  readonly V: number;
  readonly expectedMaxZ: number;
  readonly expectedMaxSharpeNull: number;
  readonly dataRangeStart: string;
  readonly dataRangeEnd: string;
  readonly ohlcvBars: number;
  readonly fundingRows: number;
}

function bps(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(2);
}
function sharpe(x: number): string {
  return x.toFixed(4);
}
function dsr(x: number): string {
  return x.toExponential(3);
}
function pass(b: boolean): string {
  return b ? 'PASS' : 'fail';
}
function bool(b: boolean): string {
  return b ? 'yes' : 'no';
}

function renderGridRow(row: CarryReportRow): string {
  const { result: r, gate: g, go } = row;
  const hPct = Math.round(r.params.entryThresholdAnnualized * 100);
  const cells = [
    r.label,
    r.symbol,
    String(r.params.entryLookback),
    `${hPct}%`,
    r.params.exitRule,
    String(r.totalEpisodes),
    String(r.trainEpisodes),
    String(r.holdoutEpisodes),
    bps(r.trainExpectancyBps),
    bps(r.holdoutExpectancyBps),
    `[${bps(r.holdoutBasisLowExpectancyBps)}, ${bps(r.holdoutBasisHighExpectancyBps)}]`,
    sharpe(r.holdoutStats.sr),
    dsr(g.dsr),
    bool(g.wfPass),
    pass(g.pass),
    go ? 'GO' : '-',
  ];
  return `| ${cells.join(' | ')} |`;
}

export function renderCarryReport(data: CarryReportData): string {
  const goRows = data.rows.filter((r) => r.go);
  const ranked = [...data.rows].sort((a, b) => b.result.holdoutStats.sr - a.result.holdoutStats.sr);
  const top3 = ranked.slice(0, 3);
  const verdict = goRows.length > 0 ? 'GO' : 'NO-GO';

  const header =
    '| Cell | Symbol | L (intervals) | H (annualized) | Exit | Episodes | Train ep | Holdout ep | ' +
    'Train exp (bps) | Holdout exp (bps) | Holdout ±2bps band (bps) | Holdout Sharpe | DSR | WF pass | ' +
    'Gate pass | GO |';
  const divider =
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

  const lines: string[] = [];
  lines.push('# Funding-carry offline study — 2026-07-10');
  lines.push('');
  lines.push(
    'Task S2 (carry-build GO/NO-GO gate, `reports/loop/state.md`). Screens a delta-neutral funding-' +
      'carry state machine (long spot + short equal-notional perp, one synthetic position of notional ' +
      'N) — enter when trailing funding is richly positive, exit on a flip or decay of that signal — ' +
      'across 7 symbols x 3 entry-lookback windows x 3 entry thresholds x 2 exit rules = 126 cells, ' +
      'for a genuine cost-covering funding edge. No cell was retried, reparametrized, or dropped to ' +
      `make a number look better — the grid is reported as-is. **Verdict: ${verdict}.**`,
  );
  lines.push('');

  lines.push('## Method');
  lines.push('');
  lines.push('### Rule (`test/backtest/carry/carry-sim.ts`)');
  lines.push('');
  lines.push(
    '- **Position:** one synthetic delta-neutral unit (long spot + short equal-notional perp) of ' +
      'notional N = 1 — the spot leg cancels price risk by construction, so only the funding leg has ' +
      'PnL here. Every return below is per-unit-notional.',
  );
  lines.push(
    '- **State machine, evaluated only at funding timestamps (the 8h grid), using ONLY data strictly ' +
      'before the decision timestamp (no lookahead):**',
  );
  lines.push(
    '  - **OFF -> ON:** trailing-L-interval mean funding rate, annualized ' +
      '(`mean_per_8h_rate x 3 x 365`), >= H.',
  );
  lines.push("  - **ON -> OFF ('flip' exit):** trailing-1d (3-interval) mean funding rate <= 0.");
  lines.push("  - **ON -> OFF ('decay' exit):** trailing-1d mean funding rate, annualized, < H/2.");
  lines.push(
    '- **Accrual timing (documented choice — the task spec does not pin this down verbatim):** ' +
      'transitions are resolved first at each funding timestamp, then accrual runs against the ' +
      "POST-transition state at that same timestamp. Entering ON at t_i immediately captures t_i's " +
      "funding settlement; exiting to OFF at t_i does NOT capture t_i's settlement (already flat as " +
      'of t_i). Symmetric — one extra interval on entry, one fewer on exit.',
  );
  lines.push(
    '- **Accrual, while ON:** `fundingPayment(signedQty = -N/mark, mark, rate)` ' +
      '(`test/backtest/funding.ts`), mark = the 1h close at-or-before the funding timestamp. Positive ' +
      'rate credits the short perp (verified algebraically: signedQty = -N/mark makes ' +
      '`fundingPayment` reduce to exactly `N x rate`, independent of mark — the mark cancels because ' +
      'position size is defined as a fixed notional divided by price).',
  );
  lines.push(
    '- **Costs:** 0.12% x N at entry and 0.12% x N at exit (0.24% round trip, both legs, taker + ' +
      'slippage haircut, fixed per the task spec).',
  );
  lines.push(
    '- **Episode:** one ENTRY -> EXIT pair, net return = (accrued funding - entry cost - exit cost) / ' +
      'N. An open position at the end of the data window (no matching exit) is dropped, not counted ' +
      "— mirrors `walkRoundTrips`' closed-cycles-only convention used everywhere else in this spine.",
  );
  lines.push(
    "- **Basis-sensitivity robustness band (reported, not gated):** each episode's net return is also " +
      'computed at ∓2bps (`netReturn - 0.0002` / `netReturn + 0.0002`), reported as the holdout ' +
      'expectancy band in the grid table below.',
  );
  lines.push('');
  lines.push('### Data');
  lines.push('');
  lines.push(
    `Binance USDT-M perp OHLCV (1h) + funding-rate history, 7 symbols, already fetched: ${data.ohlcvBars} ` +
      `bars / ${data.fundingRows} funding rows each, ${data.dataRangeStart} -> ${data.dataRangeEnd} (~2.0y).`,
  );
  lines.push('');
  lines.push('| Symbol | OHLCV bars | Funding rows | Range (UTC) |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| BTC, ETH, SOL, DOGE, XRP, AVAX, LINK | ${data.ohlcvBars} | ${data.fundingRows} | ` +
      `${data.dataRangeStart} -> ${data.dataRangeEnd} |`,
  );
  lines.push('');
  lines.push('### Grid and split');
  lines.push('');
  lines.push(
    '126 cells = 7 symbols x L{9, 21, 42} (3d/7d/14d entry lookback) x H{5%, 8%, 12%} (annualized entry ' +
      'threshold) x E{flip, decay} (exit rule). Each cell runs ONE continuous state-machine pass over its ' +
      "symbol's full funding history, then every CLOSED episode is bucketed into train/holdout by " +
      'whether its entry ("open") timestamp falls before/after the 70%-by-episode-count split point ' +
      '— chronological 70/30 by episode open time, per the task spec.',
  );
  lines.push('');
  lines.push('### Walk-forward robustness check');
  lines.push('');
  lines.push(
    "`walk-forward.ts`'s anchored/rolling machinery is built for a BarStrategy driven bar-by-bar " +
      "through `harness.ts`'s `runBacktest`; it does not fit a pre-computed per-episode return series, " +
      'so this study implements a simple anchored equal-count segmentation instead (documented here ' +
      `rather than silently reused where its API does not apply): each cell's FULL episode series ` +
      `(train+holdout together, chronological) is split into up to ${4} equal-count segments, and the ` +
      'gate requires the summed net return to be positive in EVERY segment. Applied over the full ' +
      'series rather than holdout-only because holdout alone is too thin to sub-segment for most cells. ' +
      'Fewer than 2 total episodes fails this check conservatively (cannot be meaningfully segmented).',
  );
  lines.push('');
  lines.push('### Deflation methodology (N = 178)');
  lines.push('');
  lines.push(
    `N = 178 = this study's 126 cells + the ${data.priorCount} pre-existing \`PRIOR_TRIALS\` entries ` +
      '(`test/backtest/trial-registry.ts`, the SeedEntryStrategy edge-diagnostic grid, ' +
      '`reports/loop/edge-diagnostic-2026-07-10.md`). V is the WINSORIZED (|SR| clipped to 3, ' +
      "`stats.ts`'s `winsorizedVariance`) cross-trial variance of the UNION of " +
      '126 per-cell HOLDOUT Sharpe ratios (this study) and 52 FULL-SAMPLE Sharpe ratios ' +
      "(`trial-registry.ts`'s `harvest()`, as the task spec names it). `harvest()` cross-products every " +
      'spec against every interval in its bars map rather than filtering by `spec.symbol`/`spec.interval` ' +
      '— to get exactly 52 honestly-paired results, this study calls `harvest()` once per prior spec with ' +
      "a single-spec/single-interval map. `FEE_BPS_VIP0` (10bps) + `harvest()`'s hardcoded 5bps haircut " +
      "reproduces `fill-models.ts`'s `DEFAULT_FILL_CONFIG` exactly, matching the original edge-diagnostic " +
      "run's fill economics.",
  );
  lines.push('');
  lines.push('## Selection-correction benchmark');
  lines.push('');
  lines.push(`- N (total trials, this study + PRIOR_TRIALS) = **${data.N}**`);
  lines.push(
    `- V (winsorized cross-trial variance of the union of holdout/full-sample Sharpes) = **${data.V.toFixed(7)}**`,
  );
  lines.push(
    `- E[max Z_${data.N}] (False-Strategy-Theorem benchmark) = **${data.expectedMaxZ.toFixed(4)}**`,
  );
  lines.push(
    `- E[max Sharpe] under the null, SR0* = sqrt(V) x E[max Z_${data.N}] = **${data.expectedMaxSharpeNull.toFixed(4)}**`,
  );
  lines.push('');

  const OUTLIER_THRESHOLD = 10;
  const outlierRows = data.rows.filter(
    (r) => Math.abs(r.result.holdoutStats.sr) > OUTLIER_THRESHOLD,
  );
  const oneEpisodeCells = data.rows.filter((r) => r.result.holdoutEpisodes <= 1).length;
  lines.push(
    '**Observation — V is dominated by a handful of extreme-outlier per-cell holdout Sharpes, not by ' +
      'typical cross-trial spread.** The 52 PRIOR_TRIALS full-sample Sharpes are all bounded within ' +
      `[${data.priorSrMin.toFixed(4)}, ${data.priorSrMax.toFixed(4)}] — the ordinary range seen in ` +
      `\`reports/loop/edge-diagnostic-2026-07-10.md\`. This study's own 126 holdout Sharpes are NOT: ` +
      `${outlierRows.length} of them exceed |SR| = ${OUTLIER_THRESHOLD} (worst: \`` +
      `${outlierRows.length > 0 ? [...outlierRows].sort((a, b) => Math.abs(b.result.holdoutStats.sr) - Math.abs(a.result.holdoutStats.sr))[0]!.result.label : 'n/a'}` +
      `\` at SR ${outlierRows.length > 0 ? sharpe([...outlierRows].sort((a, b) => Math.abs(b.result.holdoutStats.sr) - Math.abs(a.result.holdoutStats.sr))[0]!.result.holdoutStats.sr) : 'n/a'}` +
      `). This is a real property of the per-trade Sharpe formula (mean/population-std) applied to ` +
      'small holdout samples (2-23 episodes) whose net returns happen to cluster tightly around a ' +
      'negative mean (the fixed 24bps round-trip cost dominating a thin funding accrual in most losing ' +
      `episodes) — not a bug, and not filtered or reparametrized away. Separately, ${oneEpisodeCells} ` +
      "cells have <=1 holdout episode and contribute exactly SR = 0 (`sharpeStats`' zero-variance " +
      'guard on a single-point series). Net effect: V is pulled far above what the ordinary cross-trial ' +
      `spread would suggest, inflating SR0* to ${data.expectedMaxSharpeNull.toFixed(2)} — a bar no ` +
      'plausible per-trade Sharpe could clear, so the DSR component of the gate is effectively ' +
      'unpassable for this specific trial pool composition, independent of whether any cell has genuine ' +
      'edge. See Caveats.',
  );
  lines.push('');

  lines.push('## Results — full 126-cell grid');
  lines.push('');
  lines.push(
    'Train/holdout expectancy is net-of-cost per episode (0.24% round-trip cost baked into `netReturn`), ' +
      'in basis points. Holdout Sharpe / DSR use the N/V above. "Gate pass" is the full step-D 4-part ' +
      'gate (`stats.ts` `evaluateGate`: tStat > 3.0, DSR > 0.95, holdout episodes >= MinBTL, WF positive ' +
      'every segment); "GO" additionally requires holdout net expectancy > 0 and holdout episodes >= ' +
      `${8}.`,
  );
  lines.push('');
  lines.push(header);
  lines.push(divider);
  for (const row of data.rows) lines.push(renderGridRow(row));
  lines.push('');

  lines.push('## Seam / GO list');
  lines.push('');
  if (goRows.length === 0) {
    lines.push('**Empty. Zero of 126 cells meet all GO criteria.**');
    lines.push('');
    lines.push('Top 3 cells by holdout Sharpe (for reference, none reaching GO):');
    lines.push('');
    for (const r of top3) {
      const g = r.gate;
      lines.push(
        `- \`${r.result.label}\`: holdout Sharpe ${sharpe(r.result.holdoutStats.sr)}, DSR ${dsr(g.dsr)}, ` +
          `holdout exp ${bps(r.result.holdoutExpectancyBps)}bps/episode, holdout episodes ` +
          `${r.result.holdoutEpisodes}, gate pass = ${pass(g.pass)}.`,
      );
    }
  } else {
    lines.push(`**${goRows.length} of 126 cells clear GO:**`);
    lines.push('');
    for (const r of goRows) {
      lines.push(
        `- \`${r.result.label}\`: holdout Sharpe ${sharpe(r.result.holdoutStats.sr)}, DSR ${dsr(r.gate.dsr)}, ` +
          `holdout exp ${bps(r.result.holdoutExpectancyBps)}bps/episode, holdout episodes ` +
          `${r.result.holdoutEpisodes}.`,
      );
    }
  }
  lines.push('');

  lines.push(`## Verdict: **${verdict}**`);
  lines.push('');
  if (verdict === 'NO-GO') {
    const best = ranked[0];
    if (best) {
      lines.push(
        `Zero of 126 cells clear the GO bar. Best cell by holdout Sharpe: \`${best.result.label}\` ` +
          `(Sharpe ${sharpe(best.result.holdoutStats.sr)}, DSR ${dsr(best.gate.dsr)}, holdout exp ` +
          `${bps(best.result.holdoutExpectancyBps)}bps/episode over ${best.result.holdoutEpisodes} ` +
          `holdout episodes) — gate pass = ${pass(best.gate.pass)}.`,
      );
    }
  } else {
    lines.push(`${goRows.length} cell(s) clear every GO criterion — see the seam list above.`);
  }
  lines.push('');

  lines.push('## Caveats');
  lines.push('');
  lines.push(
    '- **Single 70/30 split, not a full walk-forward, for the headline holdout expectancy.** The ' +
      'walk-forward check above is a separate, coarser robustness screen (positive-every-segment over the ' +
      'full series); it does not replace holding out a genuinely unseen final slice.',
  );
  lines.push(
    '- **Funding-only PnL model.** This study excludes basis (spot-perp price) drift entirely — the ' +
      'position is treated as perfectly delta-neutral with zero basis risk. The ±2bps band reported per ' +
      'cell is a fixed robustness sensitivity, not a model of realized basis risk, which could be larger ' +
      'or smaller depending on venue/rebalancing frequency.',
  );
  lines.push(
    "- **Costs fixed at 0.24% round trip** (0.12% x 2 legs), not swept or fit — a real deployment's " +
      'costs depend on venue, order type, and size, and could differ meaningfully from this fixed ' +
      'assumption.',
  );
  lines.push(
    '- **Demo funding is simulated** (BINANCE_DEMO_* futures-demo funding rates are synthetic/replayed, ' +
      'per prior program notes) — nothing in this study calibrates against demo-venue behavior; it is a ' +
      'pure historical-data backtest.',
  );
  lines.push(
    "- **Accrual-timing asymmetry.** Entering ON at a funding timestamp captures that timestamp's " +
      'settlement; exiting does not. This is mildly optimistic per episode on the entry side, partially ' +
      'offset by the exclusion on the exit side — not expected to materially bias the grid, but not zero ' +
      'either.',
  );
  lines.push(
    "- **Sharpe heterogeneity in the N=178 union.** This study's 126 cells contribute HOLDOUT Sharpes; " +
      'the 52 PRIOR_TRIALS entries contribute FULL-SAMPLE Sharpes (see Deflation methodology above). V is ' +
      'dominated by the 126 carry cells, so this has limited leverage over the benchmark — but it is not ' +
      'an apples-to-apples pool.',
  );
  lines.push(
    '- **A handful of extreme-outlier holdout Sharpes inflate V far above the ordinary cross-trial ' +
      'spread** (see the Observation above the grid table) — small holdout samples whose net returns ' +
      'cluster tightly around a negative mean produce very large |SR| via the mean/population-std ' +
      'formula. This pushes the deflation benchmark (SR0*) far out of reach for any plausible per-trade ' +
      'Sharpe, making the DSR gate component the binding (and effectively unpassable) constraint here — ' +
      'not the tStat, length, or WF checks. Separately, cells with <=1 holdout episode get `sr = 0` from ' +
      "`sharpeStats`' zero-variance guard (the same include-all convention `run-scan.ts` uses for the " +
      'edge-diagnostic grid) rather than being excluded, which moderates V slightly in the other ' +
      'direction. Neither effect was filtered, excluded, or reparametrized away — both are reported ' +
      'exactly as the specified methodology produces them.',
  );
  lines.push('');

  return lines.join('\n');
}
