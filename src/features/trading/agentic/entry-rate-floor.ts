import { z } from 'zod';
import Decimal from 'decimal.js';
import { price, qty } from '../../../domain/types/money';
import { SPOT_VENUE_ID, PERP_VENUE_ID } from '../../../domain/types/venue-map';
import type {
  AgentDirectives,
  AgentTradingProfile,
  AgentUsage,
} from '../../../ports/agentic-strategy';
import {
  buildPlaybookBlock,
  buildSystemPrompt,
  buildTradeTool,
  type SymbolCapabilities,
} from './agent-prompt';
import { tradeDecisionSchema } from './anthropic-agent-client';

// Backlog #39 mint-time entry-rate floor: a reflection candidate minted from all-loss evidence can
// rationally raise the entry bar so far that it structurally never fires (observed live: v2 entered
// 0 of 17 real FLAT consults). Such a candidate can never accrue the attributed trips its own
// promotion verdict needs, so it squats in the A/B slot until the unresolved-candidate lapse. This
// module answers one narrow, offline question — "would the DECIDE model, under this DRAFT playbook,
// have entered any of these real recorded FLAT-position market states" — by replaying the exact
// recorded payload strings through ONE live call per row, under the v2 rich decision contract (P3:
// migrated off the legacy submit_plan shape — see replayPlanRow below), the same request shape the
// live decide path sends. It is UNABLE to mint or promote anything itself: the caller
// (reflection.service.ts) is the only place a veto or a pass is acted on.

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
  makerBps: '10',
  takerBps: '10',
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
  readonly action?: 'open_long' | 'open_short' | 'close' | 'adjust' | 'hold';
  // Present only when action is 'open_long'/'open_short' — the only actions the v2 schema's own
  // requireTradeDirectives superRefine guarantees carry the full directive set (see
  // anthropic-agent-client.ts). AgentDirectives, not the legacy AgentPlan shape — P3 supersedes this
  // file's own pre-migration `plan` shape.
  readonly plan?: AgentDirectives;
  readonly usage?: AgentUsage;
}

// The shared call-builder both measureEntryRate (this file) and candidate-backtest.ts's mint-time
// expectancy backtest replay through: ONE v2 (submit_trade) Anthropic call for a single
// (systemPrompt, playbookBlock, rowPayload) triple, forced tool_choice, thinking off, playbook block
// cached — the exact request shape the live decide path sends under the rich decision contract.
// Extracted so the two callers can never let their request-building drift apart (backlog #39's
// companion feature reuses this verbatim rather than duplicating the fetch/timeout/parse plumbing).
export async function replayPlanRow(
  cfg: PlanReplayCallConfig,
  systemPrompt: string,
  playbookBlock: string,
  rowPayload: string,
  fetchFn: typeof fetch,
): Promise<PlanReplayResult> {
  // v3: this replay's own capabilities object — venue/leverage are illustrative (this harness asks a
  // structural question, not a live-venue one; see DEFAULT_FLOOR_PROFILE's own comment), shorts/
  // maxSizeFraction are the two facts that actually vary the tool/schema shape.
  const caps: SymbolCapabilities = {
    venue: cfg.shortsEnabled ? PERP_VENUE_ID : SPOT_VENUE_ID,
    shorts: cfg.shortsEnabled ?? false,
    leverage: '2',
    maxSizeFraction: cfg.sizeFractionMax,
    venueFreeCash: '0',
  };
  const tool = buildTradeTool(caps);
  // sizeFractionMax is money-adjacent (AgentDirectives.sizeFraction's own comment) — Decimal→toNumber,
  // never Number()/parseFloat(), mirrors agent-prompt.ts's own DECISION_V2_BOUNDS.stopLossPct.max
  // conversion (this is a schema BOUND, not a stored money value, so a plain number result is fine).
  const sizeFractionMaxNum = new Decimal(cfg.sizeFractionMax).toNumber();
  const schema = tradeDecisionSchema(sizeFractionMaxNum);

  // W2.4-style cache split: the playbook block (the stable prefix shared by every row in this batch)
  // rides its own cache_control block; the volatile per-row market payload follows uncached — same
  // two-block layout as anthropic-agent-client.ts's own userContent.
  const userContent: FloorTextBlock[] = [
    { type: 'text', text: playbookBlock, cache_control: EPHEMERAL_1H },
    { type: 'text', text: `\n\n${rowPayload}` },
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
    if (!res.ok) return { ok: false };
    const body: unknown = await res.json();
    const envelope = floorResponseSchema.safeParse(body);
    if (!envelope.success) return { ok: false };
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
    if (!toolBlock) return { ok: false, usage };
    const parsed = schema.safeParse(toolBlock.input);
    if (!parsed.success) return { ok: false, usage };
    const action = parsed.data.action;
    const isOpen = action === 'open_long' || action === 'open_short';
    return {
      ok: true,
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
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface EntryRateFloorConfig extends PlanReplayCallConfig {
  readonly playbookContent: string;
}

export type EntryRateMeasurement =
  | { readonly consults: number; readonly entries: number; readonly usages: readonly AgentUsage[] }
  | { readonly skipped: string };

// Replays `rows` (recorded AgentDecisionRow.inputPayload strings, already filtered to FLAT-position
// consults by the caller) through ONE live Anthropic call each, sequentially — small enough a batch
// (see reflection.service.ts's mintFloorRows default) that a delay between calls buys nothing. A
// malformed/failed single call costs one skipped row, never the whole floor (mirrors this codebase's
// recorded-payload eval harness's own per-row degrade-not-abort convention). Never throws.
export async function measureEntryRate(
  cfg: EntryRateFloorConfig,
  rows: readonly string[],
  fetchFn: typeof fetch,
): Promise<EntryRateMeasurement> {
  if (rows.length === 0) {
    return { skipped: 'no rows to replay' };
  }

  // v3 consolidation spec §4.4: buildSystemPrompt always builds the rich-decision-contract prompt
  // now (no more tradeContract/shortsEnabled options — shorts is documented unconditionally, and the
  // legacy plan-mode minEdgeMultiple/minRr sentence is gone with the legacy prompt it belonged to).
  const systemPrompt = buildSystemPrompt(DEFAULT_FLOOR_PROFILE);
  const playbookBlock = buildPlaybookBlock(cfg.playbookContent);

  let consults = 0;
  let entries = 0;
  const usages: AgentUsage[] = [];

  for (const rowPayload of rows) {
    const result = await replayPlanRow(cfg, systemPrompt, playbookBlock, rowPayload, fetchFn);
    if (result.usage) usages.push(result.usage);
    if (!result.ok) continue;
    consults += 1;
    if (result.action === 'open_long' || result.action === 'open_short') entries += 1;
  }

  return { consults, entries, usages };
}
