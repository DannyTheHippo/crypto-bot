import { z } from 'zod';
import Decimal from 'decimal.js';
import { price, qty } from '../../../domain/common/types/money';
import { SPOT_VENUE_ID, PERP_VENUE_ID } from '../../../domain/venue/types/venue-map';
import type {
  AgentDirectives,
  AgentTradingProfile,
  AgentUsage,
} from '../../../ports/strategy/agentic-strategy';
import { buildTradeTool, type SymbolCapabilities } from './agent-prompt';
import { tradeDecisionSchema } from './anthropic-agent-client';

// Offline single-row replay of the DECIDE path: given a recorded AgentDecisionRow.inputPayload
// string, ask what the decide model would have done under a given playbook, by re-issuing ONE live
// call in the exact request shape the live decide path sends (v2 rich decision contract — P3
// migrated it off the legacy submit_plan shape; see replayPlanRow below). Introduced for backlog
// #39's mint-time entry-rate floor, whose measureEntryRate driver was deleted with the in-process
// reflection loop on 2026-07-30 (research/studies/entry-rate-rederivation-2026-07-30.md). What
// survives here is the replay primitive itself. Its remaining callers are both research-side as of
// 2026-07-30 — test/backtest/agentic-replay-r1.ts and test/eval/agentic/playbook-space-replay.spec.ts
// (candidate-backtest.ts no longer imports it; it replays plans through plan-executor directly). It is
// UNABLE to mint or promote anything: every verdict is the caller's.

// Illustrative default profile for the replay's system prompt — the floor asks a structural
// question ("does this playbook's entry bar ever fire"), not "what is the strategy's live fee tier
// right now", so an exact runtime profile isn't required for the prompt to be representative. Mirrors
// anthropic-agent-client.ts's own DEFAULT_TRADING_PROFILE / test/eval/agentic/fixtures.ts's
// EVAL_PROFILE (redefined here, not imported — the eval fixture lives under test/, and this file is
// production code the eval harness itself may one day reuse in the other direction).
// Exported so candidate-backtest.ts (the mint-time expectancy backtest, one stage further along the
// same replay pipeline) reuses the exact same illustrative profile rather than defining its own
// slightly-different copy — both modules ask a structural/comparative question, never "what is the
// strategy's live fee tier right now".
export const DEFAULT_FLOOR_PROFILE: AgentTradingProfile = {
  spotFees: { makerBps: '10', takerBps: '10' },
  perpFees: { makerBps: '2', takerBps: '5' },
  baseNotional: '50',
  maxOrderNotional: '200',
  constraints: {
    tickSize: price('0.01'),
    lotStep: qty('0.0001'),
    minNotional: price('10'),
  },
};

// Mirrors anthropic-agent-client.ts's own EPHEMERAL_1H/AnthropicTextBlock exactly (redefined here per
// this codebase's convention of scoped local structural types rather than importing module-private
// constants) — the replay batch shares ONE cached system+playbook prefix across every row, the same
// way live decides do.
const EPHEMERAL_1H = { type: 'ephemeral', ttl: '1h' } as const;
interface FloorTextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: typeof EPHEMERAL_1H;
}

// Only the envelope fields this replay reads — mirrors anthropic-agent-client.ts's own
// anthropicResponseSchema (narrower: no thinking blocks, since the replay disables thinking exactly
// like the live decide call does).
const floorResponseSchema = z.object({
  stop_reason: z.string().optional(),
  content: z
    .array(
      z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() }),
    )
    .optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * Whether a replay used the capabilities the LIVE system recorded on that row, or fell back to the
 * config-derived stand-in. Surfaced per call so a caller can require faithfulness — see replayPlanRow's
 * own failure-direction note.
 */
export type CapabilitiesSource = 'recorded' | 'config';

// The capabilities block as the live decide payload records it (agent-prompt.ts renders this same shape
// into the tool description). Every field required: a partial block is a different contract, and
// silently filling the gaps with constants is the defect this schema exists to stop.
const recordedCapabilitiesSchema = z.object({
  capabilities: z.object({
    venue: z.string(),
    shorts: z.boolean(),
    leverage: z.string(),
    maxSizeFraction: z.string(),
    venueFreeCash: z.string(),
  }),
});

/**
 * The capabilities the live system actually presented to the model on this row, or undefined when the
 * payload does not carry them (synthetic fixtures, pre-v3 corpora).
 *
 * Never throws: a malformed payload is a measurement problem for the caller to report, not a reason to
 * abort a replay batch.
 */
export function recordedCapabilities(rowPayload: string): SymbolCapabilities | undefined {
  let parsed: ReturnType<typeof recordedCapabilitiesSchema.safeParse>;
  try {
    parsed = recordedCapabilitiesSchema.safeParse(JSON.parse(rowPayload));
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  const caps = parsed.data.capabilities;
  // `venue` is a BRANDED VenueId, so the recorded string is resolved against the two ids this system
  // knows rather than cast. An unrecognised venue falls back to the config path instead of being
  // force-branded — a replay against a venue the code does not model is not a faithful replay.
  const venue =
    caps.venue === String(PERP_VENUE_ID)
      ? PERP_VENUE_ID
      : caps.venue === String(SPOT_VENUE_ID)
        ? SPOT_VENUE_ID
        : undefined;
  if (venue === undefined) return undefined;
  return {
    venue,
    shorts: caps.shorts,
    leverage: caps.leverage,
    maxSizeFraction: caps.maxSizeFraction,
    venueFreeCash: caps.venueFreeCash,
  };
}

export interface PlanReplayCallConfig {
  readonly apiKey: string;
  // The DECIDE model, not the reflection model — see EntryRateFloorConfig.model's own comment.
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  // v3: the replay's own capabilities.maxSizeFraction (string form for the tool description, number
  // form for tradeDecisionSchema's zod bound — see replayPlanRow's own Decimal→toNumber comment).
  readonly sizeFractionMax: string;
  // Perp lane only — selects a shorts-capable capabilities object, mirroring the live client's own
  // per-symbol capabilities.shorts fact (shorts ⟺ perp in this codebase, per agent-prompt.ts's own
  // comment). Absent/false ⇒ spot-only (open_short unavailable), matching every spot deployment's
  // replay shape.
  readonly shortsEnabled?: boolean;
}

// Bounded result of ONE replay call — never throws (every failure mode collapses to `ok: false`).
// `usage` is populated whenever the response envelope itself parsed, even on a later failure (no
// tool block / bad schema) — same accounting-honesty convention as the pre-extraction code this
// replaces: a call that burned tokens must never vanish from cost tracking just because its payload
// was unusable.
export interface PlanReplayResult {
  readonly ok: boolean;
  /**
   * Which capabilities the call presented. Populated on EVERY return path including failures — a caller
   * checking faithfulness must not have that answer withheld by an unrelated transport error.
   */
  readonly capsSource?: CapabilitiesSource;
  readonly action?: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';
  // Present only when action is 'open_long'/'open_short' — the only actions the v2 schema's own
  // requireTradeDirectives superRefine guarantees carry the full directive set (see
  // anthropic-agent-client.ts). AgentDirectives, not the legacy AgentPlan shape — P3 supersedes this
  // file's own pre-migration `plan` shape.
  readonly plan?: AgentDirectives;
  readonly usage?: AgentUsage;
}

// The shared call-builder every replay caller goes through: ONE v2 (submit_trade) Anthropic call for a
// single (systemPrompt, playbookBlock, rowPayload) triple, forced tool_choice, thinking off, playbook
// block cached — the exact request shape the live decide path sends under the rich decision contract.
// Extracted so no caller can let its request-building drift from the others (each reuses this verbatim
// rather than duplicating the fetch/timeout/parse plumbing).
export async function replayPlanRow(
  cfg: PlanReplayCallConfig,
  systemPrompt: string,
  playbookBlock: string,
  rowPayload: string,
  fetchFn: typeof fetch,
): Promise<PlanReplayResult> {
  // v3: capabilities come from the RECORDED ROW whenever it carries them, because the row payload is
  // the ground truth for what the live system told the model on that row — and the previous
  // constant-capabilities version contradicted its own input in four places at once (2026-07-30):
  //
  //   - `venueFreeCash: '0'` while the payload advertised $380-700. The field is documented as
  //     display-grade (never a zod bound), which is precisely the trap: it is not ENFORCED, it is
  //     PERSUASIVE, and a model told it has no money holds. Measured effect: on 33 identical rows the
  //     live system entered 6 times (18.2%), this replay entered once (4.5%) with the same playbook.
  //   - `maxSizeFraction: cfg.sizeFractionMax` (0.25 as the study called it) against a payload
  //     advertising 0.35 on perp and 0.15 on spot — so the schema BOUND disagreed with the advertised
  //     limit, and a model that believed the payload and proposed 0.30 was schema-rejected for it.
  //   - `shorts: cfg.shortsEnabled` uniformly, which enabled shorts on the 139 SPOT rows where the
  //     recorded capabilities say `shorts: false`. Those short entries are unreachable live.
  //   - `leverage: '2'` on rows recorded at 1 and 5.
  //
  // FAILURE DIRECTION: falls OPEN to the cfg-derived object when the payload carries no capabilities
  // (synthetic fixtures, pre-v3 corpora) — this is a measurement harness and must never refuse to
  // measure. `capsSource` reports which path ran so a CALLER can fail closed on it; the playbook-space
  // study requires 'recorded' for every row, which is where the strictness belongs. The fallback
  // object is also SHOWN to the model on that path (see fallbackCapabilities below), so the zod bound
  // and the advertised limit agree on every path, not just the recorded one.
  const recorded = recordedCapabilities(rowPayload);
  const caps: SymbolCapabilities = recorded ?? {
    venue: cfg.shortsEnabled ? PERP_VENUE_ID : SPOT_VENUE_ID,
    shorts: cfg.shortsEnabled ?? false,
    leverage: '2',
    maxSizeFraction: cfg.sizeFractionMax,
    venueFreeCash: '0',
  };
  const capsSource: CapabilitiesSource = recorded ? 'recorded' : 'config';
  // 2026-07-30: the tool no longer carries any per-symbol capability text at all (see
  // buildTradeTool's own comment) — the recorded row's `capabilities` block, which rides in
  // rowPayload verbatim, is now the ONLY channel telling the replayed model its shorts/leverage/
  // maxSizeFraction, exactly as live. `caps` still binds the zod bound below.
  const tool = buildTradeTool();
  // maxSizeFraction is money-adjacent (AgentDirectives.sizeFraction's own comment) — Decimal→toNumber,
  // never Number()/parseFloat(), mirrors agent-prompt.ts's own DECISION_V2_BOUNDS.stopLossPct.max
  // conversion (this is a schema BOUND, not a stored money value, so a plain number result is fine).
  // Taken from `caps`, not `cfg`, so the bound and the advertised limit can no longer disagree.
  const sizeFractionMaxNum = new Decimal(caps.maxSizeFraction).toNumber();
  const schema = tradeDecisionSchema(sizeFractionMaxNum);

  // On the config path the row carries no capabilities block, so the model would be shown NO numeric
  // ceiling on ANY channel while `schema` silently bound it at cfg.sizeFractionMax — a model that
  // proposed over an unstated limit would be schema-rejected for it. That is exactly the manufactured
  // abstention entry-rate-floor-capabilities.spec.ts exists to prevent (the recorded instance of it
  // measured 2.5% against a live 16.1%), just sourced from silence instead of from disagreement. The
  // tool's own sizeFraction text points AT this block ("this symbol's own capabilities.maxSizeFraction
  // (shown in its payload block)", agent-prompt.ts) so without it the pointer dangles.
  //
  // Appended rather than merged into rowPayload, and only on this path: the recorded row text stays
  // byte-verbatim, and the tool JSON stays identical for every call (tools sit at canonical cache
  // position 0 — forking buildTradeTool per row would invalidate BOTH cache breakpoints on a mixed
  // batch, which is why the number lives in the payload channel live too).
  const fallbackCapabilities = recorded
    ? ''
    : `\n\n${JSON.stringify({
        capabilities: {
          venue: String(caps.venue),
          shorts: caps.shorts,
          leverage: caps.leverage,
          maxSizeFraction: caps.maxSizeFraction,
          venueFreeCash: caps.venueFreeCash,
        },
      })}`;
  // W2.4-style cache split: the playbook block (the stable prefix shared by every row in this batch)
  // rides its own cache_control block; the volatile per-row market payload follows uncached — same
  // two-block layout as anthropic-agent-client.ts's own userContent.
  const userContent: FloorTextBlock[] = [
    { type: 'text', text: playbookBlock, cache_control: EPHEMERAL_1H },
    { type: 'text', text: `\n\n${rowPayload}${fallbackCapabilities}` },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchFn(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 512,
        system: [{ type: 'text', text: systemPrompt, cache_control: EPHEMERAL_1H }],
        messages: [{ role: 'user', content: userContent }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        // Structured tool-use replay, not open-ended reasoning — disabled exactly like the live
        // decide call (anthropic-agent-client.ts's attemptOnce).
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, capsSource };
    const body: unknown = await res.json();
    const envelope = floorResponseSchema.safeParse(body);
    if (!envelope.success) return { ok: false, capsSource };
    const usage: AgentUsage | undefined = envelope.data.usage
      ? {
          inputTokens: envelope.data.usage.input_tokens,
          outputTokens: envelope.data.usage.output_tokens,
          cacheReadInputTokens: envelope.data.usage.cache_read_input_tokens,
          cacheCreationInputTokens: envelope.data.usage.cache_creation_input_tokens,
        }
      : undefined;
    const toolBlock = envelope.data.content?.find(
      (b) => b.type === 'tool_use' && b.name === tool.name,
    );
    if (!toolBlock) return { ok: false, usage, capsSource };
    const parsed = schema.safeParse(toolBlock.input);
    if (!parsed.success) return { ok: false, usage, capsSource };
    const action = parsed.data.action;
    const isOpen = action === 'open_long' || action === 'open_short';
    return {
      ok: true,
      capsSource,
      action,
      usage,
      // requireTradeDirectives (anthropic-agent-client.ts) guarantees sizeFraction/entry/
      // entryValidityBars/stopLossPct/takeProfitPct/maxHoldBars are all present whenever action is
      // 'open_long'/'open_short' — the `!` assertions below rely on that schema-enforced invariant,
      // not an unchecked guess. Pct/fraction fields converted to strings at the boundary — same
      // money-safe Decimal-on-strings convention AnthropicAgentClient's own mapping applies.
      ...(isOpen
        ? {
            plan: {
              sizeFraction: String(parsed.data.sizeFraction!),
              stopLossPct: String(parsed.data.stopLossPct!),
              takeProfitPct: String(parsed.data.takeProfitPct!),
              entryOffsetBps: parsed.data.entry!.offsetBps,
              entryValidityBars: parsed.data.entryValidityBars!,
              maxHoldBars: parsed.data.maxHoldBars!,
              entryStyle: parsed.data.entry!.style,
              ...(action === 'open_short' ? { direction: 'short' as const } : {}),
              ...(parsed.data.thesis !== undefined ? { thesis: parsed.data.thesis } : {}),
            } satisfies AgentDirectives,
          }
        : {}),
    };
  } catch {
    // Transport error / timeout / body-read failure — skip this row, never fail the whole caller.
    return { ok: false, capsSource };
  } finally {
    clearTimeout(timer);
  }
}
