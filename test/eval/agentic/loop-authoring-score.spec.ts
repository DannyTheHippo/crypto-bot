// Scoring call site for the loop authoring pass (`scripts/loop-authoring.mjs`, stage 4).
//
// It scores a set of DRAFTED playbook variants and the CURRENTLY RUNNING playbook against each other
// on the same corpus, the same metric and the same horizons, through the same engine that produced
// `NO_SURVIVOR` (playbook-space-replay.ts). Nothing here re-derives a bar: `computeCell`,
// `verdictFor`, `aggregateFamilyVerdict` and `compareToIncumbent` are the study's own frozen
// functions, and this file only feeds them arms and writes their answers to a JSON the shell reads.
//
// WHY IT IS A SEPARATE FILE and not an arm added to playbook-space-replay.spec.ts: that spec is a
// transcription of a frozen pre-registration whose arms were fixed before any result existed. Adding
// a run-time arm to it would make the pre-registered family a function of what the loop happens to
// draft today, which is the exact discipline the document exists to enforce. This file declares its
// own family (candidates x horizons) at the top of each run instead.
//
// FAILURE DIRECTION: the results file is written BEFORE the run's health is asserted, then the
// assertions fail the process. Both directions are closed and they are independent — the shell
// refuses to mint on a non-zero exit code AND on the `voided`/`aborted` flags in the file, so neither
// a swallowed assertion nor an unread file can let an unmeasured candidate through.
//
// DRY RUN (`LOOP_AUTHORING_DRY_RUN=1`): a scripted, deterministic, no-network fetch is injected into
// `runReplay`'s own `rawFetch` parameter. Every downstream stage — cells, both bars, the entry-rate
// floor, the gate — then runs on real arithmetic over synthetic decisions, at zero spend. It proves
// the pass end to end; it proves nothing whatever about any playbook.
//
// This module makes paid network calls unless dry-run. It is research, OFF the production test gate.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  HORIZONS,
  MIN_EDGE_ROWS,
  MIN_TRANSPORT_RATE,
  aggregateFamilyVerdict,
  assertArmsAreReachable,
  commonRowsSplitAtMs,
  compareToIncumbent,
  computeCell,
  corpusManifest,
  fwdBps,
  loadCorpus,
  loadSeries,
  preflightCanSpend,
  runReplay,
  strideSample,
  verdictFor,
  type ArmRowResult,
  type LaneCell,
  type Observation,
} from './playbook-space-replay';
import type { PlaybookArm } from './playbook-space-arms';

const SCORE = process.env.LOOP_AUTHORING_SCORE === '1';
const DRY_RUN = process.env.LOOP_AUTHORING_DRY_RUN === '1';
const VARIANTS_FILE = process.env.LOOP_AUTHORING_VARIANTS_FILE ?? '';
const OUT_FILE = process.env.LOOP_AUTHORING_OUT ?? '';
const MODEL = process.env.LOOP_AUTHORING_MODEL ?? 'claude-sonnet-5';
const BASE_URL = process.env.LOOP_AUTHORING_BASE_URL ?? 'https://api.anthropic.com';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ROWS = Number(process.env.LOOP_AUTHORING_ROWS ?? MIN_EDGE_ROWS);
const CAP_USD = process.env.LOOP_AUTHORING_CAP_USD ?? '5';

interface VariantsFile {
  readonly incumbent: { readonly name: string; readonly content: string };
  readonly candidates: readonly { readonly name: string; readonly content: string }[];
}

/**
 * Both arms are replayed in ONE process, against the same rows, with the same prompt bytes loaded
 * from the same working tree — which is precisely what `PromptSurfaceCheck.attribution` asserts. The
 * predecessor's git-blob check exists because Family A compared against a RECORDED leg from an older
 * commit; here there is no older leg, so the check would answer a question this run does not ask.
 */
const ATTRIBUTION = 'PROMPT-CONTROLLED' as const;

// ── the dry-run transport ────────────────────────────────────────────────────────────────────────

/** FNV-1a. Deterministic across processes and architectures, so a dry run reproduces exactly. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A scripted Anthropic surface. Reads the tool name out of the REQUEST rather than importing
 * `buildTradeTool`, so it cannot drift when the tool builder's signature changes; the decision it
 * returns is a pure function of (playbook block, market payload), which gives different arms
 * different — and reproducible — entry patterns without a single network call or a single cent.
 */
function scriptedFetch(): typeof fetch {
  return (...args: Parameters<typeof fetch>): Promise<Response> => {
    // BodyInit is a union that includes Blob/FormData, so `String(init.body)` would stringify some
    // members as '[object Object]'. Every call this stands in for sends a JSON string (replayPlanRow
    // builds its body with JSON.stringify), and a non-string body is a caller bug worth surfacing as
    // an empty request rather than a silently mangled one.
    const rawBody = args[1]?.body;
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as {
      tool_choice?: { name?: string };
      messages?: { content?: { text?: string }[] }[];
    };
    const toolName = body.tool_choice?.name ?? 'submit_trade';
    const blocks = body.messages?.[0]?.content ?? [];
    const seed = hash32(`${blocks[0]?.text ?? ''}|${blocks[1]?.text ?? ''}`);
    // 22 / 8 / 70 over the seed space. The REALISED rate on any given corpus differs (FNV over real
    // payloads is not uniform mod 100 — 60 rows measured 30-35%), which is fine and is the point: the
    // dry run has to produce enough entries to exercise the powered branches, and its numbers are
    // synthetic by construction. Nothing downstream may read them as an entry-rate measurement.
    const roll = seed % 100;
    const action = roll < 22 ? 'open_long' : roll < 30 ? 'open_short' : 'hold';
    const isOpen = action !== 'hold';
    const payload = {
      // Zero-token usage: the meter must price this run at exactly $0, and a fabricated token count
      // would put a number that was never billed into a cost field.
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          name: toolName,
          input: {
            action,
            ...(isOpen
              ? {
                  sizeFraction: 0.05,
                  entry: { style: 'maker', offsetBps: -10 },
                  entryValidityBars: 4,
                  stopLossPct: 0.02,
                  takeProfitPct: 0.04,
                  maxHoldBars: 48,
                }
              : {}),
          },
        },
      ],
    };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

// ── per-arm reporting ────────────────────────────────────────────────────────────────────────────

interface ArmReport {
  readonly arm: string;
  readonly role: 'incumbent' | 'candidate';
  readonly rowsReplayed: number;
  readonly rowsParsed: number;
  readonly entries: number;
  readonly entryRate: number;
  readonly schemaValidRate: number;
  readonly actionHistogram: Record<string, number>;
  readonly decisionsChangedVsIncumbent: number;
  readonly cells: readonly (LaneCell & { readonly failedClause: string | null })[];
}

function histogram(results: readonly ArmRowResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) {
    const key = r.action ?? 'unparsed';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe.runIf(SCORE)(
  'loop authoring — score drafted variants against the running playbook',
  () => {
    it(
      'replays every variant and the incumbent on identical rows and writes both bars',
      { timeout: 6 * 60 * 60 * 1000 },
      async () => {
        expect(VARIANTS_FILE, 'LOOP_AUTHORING_VARIANTS_FILE is required').not.toBe('');
        expect(OUT_FILE, 'LOOP_AUTHORING_OUT is required').not.toBe('');
        const variants = JSON.parse(readFileSync(VARIANTS_FILE, 'utf8')) as VariantsFile;
        expect(variants.candidates.length).toBeGreaterThan(0);

        const corpus = loadCorpus();
        const manifest = corpusManifest(corpus);
        const rows = strideSample(corpus, ROWS);
        const series = loadSeries(rows.map((r) => r.symbol));

        // Incumbent FIRST: it is both the deployment comparator and the decision-change reference, and
        // chunk-major execution means arm order also decides which arms survive a budget abort — so the
        // one arm whose absence would void every comparison runs first.
        const named: readonly {
          readonly name: string;
          readonly content: string;
          readonly role: ArmReport['role'];
        }[] = [
          {
            name: variants.incumbent.name,
            content: variants.incumbent.content,
            role: 'incumbent',
          },
          ...variants.candidates.map((c) => ({ ...c, role: 'candidate' as const })),
        ];
        const arms: { arm: PlaybookArm; content: string }[] = named.map((v) => ({
          arm: {
            name: v.name,
            source: { kind: 'literal' as const },
            content: v.content,
            tests:
              v.role === 'incumbent'
                ? 'the RUNNING playbook — the deployment comparator'
                : 'a loop-drafted candidate',
          },
          content: v.content,
        }));
        // An arm the live validator would reject is not a reachable point in playbook space. Throws.
        assertArmsAreReachable(arms);

        const cells = named.length * HORIZONS.length;
        const scoredCells = variants.candidates.length * HORIZONS.length;
        // Declared HERE, before any result is seen, over the SCORED cells only — the incumbent is a
        // comparator and can never PASS, so its cells never enter the family it would otherwise inflate.
        const alpha = 0.05 / scoredCells;

        console.log(
          `\nloop-authoring score${DRY_RUN ? ' (DRY RUN — scripted transport, $0)' : ''}`,
        );
        console.log(
          `corpus: ${manifest.rows} rows, ${manifest.symbols} symbols, sha256 ${manifest.payloadSha256}`,
        );
        console.log(`rows this run: ${rows.length}   model: ${MODEL}`);
        console.log(
          `incumbent: ${variants.incumbent.name}   candidates: ${variants.candidates.map((c) => c.name).join(', ')}`,
        );
        console.log(
          `family: ${scoredCells} scored cells (of ${cells} computed), alpha ${alpha.toExponential(4)}\n`,
        );

        if (!DRY_RUN) {
          // ONE call before hundreds — the old pre-flight checked that a key EXISTED, never that it
          // could SPEND, and two runs burned a corpus discovering the difference mid-flight.
          const preflight = await preflightCanSpend(API_KEY, MODEL, BASE_URL);
          expect(
            preflight.ok,
            `PRE-FLIGHT FAILED — HTTP ${preflight.status}: ${preflight.detail}`,
          ).toBe(true);
        }

        const run = await runReplay(
          rows,
          arms,
          {
            apiKey: DRY_RUN ? 'dry-run-no-key' : API_KEY,
            model: MODEL,
            baseUrl: BASE_URL,
            timeoutMs: Number(process.env.LOOP_AUTHORING_TIMEOUT_MS ?? 120_000),
            sizeFractionMax: '0.25',
            shortsEnabled: true,
            rowsPerChunk: Number(process.env.LOOP_AUTHORING_CHUNK ?? 40),
            concurrency: Number(process.env.LOOP_AUTHORING_CONCURRENCY ?? 4),
            capUsd: DRY_RUN ? '0' : CAP_USD,
            reservePerCallUsd: DRY_RUN ? '0' : '0.05',
            onProgress: (m) => console.log(`  ${m}`),
          },
          DRY_RUN ? scriptedFetch() : fetch,
        );

        const incumbentName = variants.incumbent.name;
        const reference = run.perArm.get(incumbentName) ?? [];
        const reports: ArmReport[] = [];

        // The run's ONE split instant for the deployment bar's chronological-halves clause: the
        // median eventTime of the COMMON row set, computed once, before any comparison is read. This
        // pass re-measures the incumbent IN-RUN, so unlike the Family A path the clause is genuinely
        // determinable here — both sides have per-entry times against the same boundary.
        const splitAtMs = commonRowsSplitAtMs(run.perArm);

        for (const v of named) {
          const results = run.perArm.get(v.name) ?? [];
          const parsed = results.filter((r) => r.ok);
          const entries = parsed
            .filter((r) => r.action === 'open_long' || r.action === 'open_short')
            .map((r) => ({
              symbol: r.symbol,
              eventTime: r.eventTime,
              dir: r.action === 'open_short' ? (-1 as const) : (1 as const),
            }));
          const changed = results.filter((r) => {
            const ref = reference.find((c) => c.rowId === r.rowId);
            return ref !== undefined && ref.action !== r.action;
          }).length;

          const armCells: (LaneCell & { failedClause: string | null })[] = [];
          for (const h of HORIZONS) {
            const obs: Observation[] = [];
            for (const e of entries) {
              const val = fwdBps(series, e.symbol, e.eventTime, h, e.dir);
              if (val !== null) obs.push({ symbol: e.symbol, bps: val, eventTime: e.eventTime });
            }
            // Seed is a pure function of (arm, horizon) so the whole run reproduces, and differs per
            // cell so no two cells share a resampling stream.
            const stats = computeCell(
              obs,
              entries.map((e) => ({ symbol: e.symbol, dir: e.dir })),
              series,
              h,
              20260730 + (hash32(v.name) % 100000) + h,
              splitAtMs,
            );
            const { verdict, failedClause } = verdictFor(stats, alpha);
            // `...stats` FIRST so it supplies LaneCell's n/mean/ciLo along with the clauses the
            // verdict was computed from (ciHi, pVsBar, placeboP, halves, trimmed) — those ride into
            // the results file so a reader can re-check the verdict rather than take it on trust.
            armCells.push({ ...stats, model: MODEL, arm: v.name, h, verdict, failedClause });
          }

          reports.push({
            arm: v.name,
            role: v.role,
            rowsReplayed: results.length,
            rowsParsed: parsed.length,
            entries: entries.length,
            entryRate: parsed.length > 0 ? entries.length / parsed.length : 0,
            schemaValidRate: results.length > 0 ? parsed.length / results.length : 0,
            actionHistogram: histogram(results),
            decisionsChangedVsIncumbent: changed,
            cells: armCells,
          });
        }

        const byArm = new Map(reports.map((r) => [r.arm, r]));
        const incumbentCells = byArm.get(incumbentName)?.cells ?? [];
        const deployment = variants.candidates.map((c) =>
          compareToIncumbent(
            c.name,
            byArm.get(c.name)?.cells ?? [],
            incumbentName,
            incumbentCells,
            ATTRIBUTION,
            splitAtMs,
          ),
        );
        // Only candidate cells enter the research verdict — the comparator can never PASS, and the way
        // to honour that is to never hand its numbers to a verdict function in the first place.
        const research = aggregateFamilyVerdict(
          variants.candidates.flatMap((c) => byArm.get(c.name)?.cells ?? []),
          scoredCells,
        );

        const costPerDecideUsd = run.meter.calls > 0 ? Number(run.meter.usd) / run.meter.calls : 0;
        const out = {
          generatedAt: new Date().toISOString(),
          dryRun: DRY_RUN,
          model: MODEL,
          incumbentArm: incumbentName,
          corpus: manifest,
          rowsRequested: rows.length,
          rowsCovered: run.rowsCovered,
          // The run's ONE split instant, so every halves figure in `deployment` below is re-derivable
          // from this file alone. null means the clause had no boundary and read UNDETERMINED.
          halvesSplitAtMs: splitAtMs ?? null,
          alpha,
          cellsDeclared: scoredCells,
          horizons: [...HORIZONS],
          attribution: ATTRIBUTION,
          meter: run.meter,
          costPerDecideUsd,
          transport: run.transport,
          completion: run.completion,
          voided: run.voided,
          aborted: run.aborted,
          unfaithfulCapsRows: run.unfaithfulCapsRows,
          minTransportRate: MIN_TRANSPORT_RATE,
          arms: reports,
          deployment,
          research,
        };
        mkdirSync(dirname(OUT_FILE), { recursive: true });
        // Written BEFORE the health assertions below, so a voided run still leaves the shell a file
        // that says so — see this file's header on the two independent closed paths.
        writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
        console.log(`\nwrote ${OUT_FILE}`);

        for (const d of deployment) {
          console.log(
            `DEPLOYMENT ${d.arm} vs ${d.incumbent}: ${d.horizonsWon}/${d.horizonsCompared} horizons, ` +
              `primary h=${d.primaryHorizon} ${d.beatsAtPrimary ? 'won' : 'lost'}, halves ` +
              `${d.halvesVerdict} ⇒ ${d.ships ? 'SHIPS' : 'does NOT ship'}`,
          );
          console.log(`  halves: ${d.halves.reason}`);
        }
        console.log(
          `RESEARCH ${research.cellsScored}/${research.cellsDeclared} cells, ${research.passes.length} passes ⇒ ${research.verdict}`,
        );

        expect(run.transport.billingStop, 'provider reported an unrecoverable billing state').toBe(
          null,
        );
        // FAILS CLOSED on faithfulness: a replay presenting capabilities the live system never recorded
        // measures a different account (the 2026-07-30 venueFreeCash defect, worth 4x the entry rate).
        expect(run.unfaithfulCapsRows, 'rows replayed with unrecorded capabilities').toBe(0);
        expect(
          run.voided,
          `transport ${(run.completion.transportRate * 100).toFixed(1)}% below floor`,
        ).toBe(false);
        expect(run.rowsCovered, 'no rows common to every arm').toBeGreaterThan(0);
      },
    );
  },
);

describe('loop authoring scripted transport', () => {
  const call = async (playbook: string, payload: string): Promise<Response> =>
    scriptedFetch()('https://example.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        tool_choice: { name: 'submit_trade' },
        messages: [{ role: 'user', content: [{ text: playbook }, { text: payload }] }],
      }),
    });

  it('prices every call at exactly zero — a dry run must never fabricate a token count', async () => {
    const body = (await call('pb', 'row')).json() as Promise<{
      usage: { input_tokens: number; output_tokens: number };
    }>;
    expect(await body).toMatchObject({ usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it('is deterministic in (playbook, row) so a dry run reproduces exactly', async () => {
    const first = await (await call('pb', 'row')).text();
    expect(await (await call('pb', 'row')).text()).toBe(first);
  });

  it('gives different playbooks different decisions — otherwise the comparison is vacuous', async () => {
    const actions: string[] = [];
    for (const pb of ['arm-a', 'arm-b', 'arm-c', 'arm-d']) {
      for (let i = 0; i < 8; i += 1) {
        const parsed = (await (await call(pb, `row-${i}`)).json()) as {
          content: { input: { action: string } }[];
        };
        actions.push(parsed.content[0]!.input.action);
      }
    }
    expect(new Set(actions).size).toBeGreaterThan(1);
  });

  it('answers on the tool the request asked for, not a hardcoded name', async () => {
    const res = await scriptedFetch()('https://example.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        tool_choice: { name: 'renamed_tool' },
        messages: [{ role: 'user', content: [{ text: 'pb' }, { text: 'row' }] }],
      }),
    });
    const parsed = (await res.json()) as { content: { name: string }[] };
    expect(parsed.content[0]!.name).toBe('renamed_tool');
  });

  it('keeps its results path out of the repo unless asked for', () => {
    // Guards a shape that has bitten this repo before: a default OUT that lands inside the tree turns
    // every dry run into an untracked-file cleanup problem. The shell passes an explicit $TMPDIR path.
    expect(OUT_FILE === '' || !existsSync(join(process.cwd(), 'loop-authoring-score.json'))).toBe(
      true,
    );
  });
});
