import { z } from 'zod';
import { price, qty } from '../../../domain/types/money';
import type { AgentTradingProfile, AgentUsage } from '../../../ports/agentic-strategy';
import { PLAN_TOOL, buildPlaybookBlock, buildSystemPrompt } from './agent-prompt';

// Backlog #39 mint-time entry-rate floor: a reflection candidate minted from all-loss evidence can
// rationally raise the entry bar so far that it structurally never fires (observed live: v2 entered
// 0 of 17 real FLAT consults). Such a candidate can never accrue the attributed trips its own
// promotion verdict needs, so it squats in the A/B slot until the unresolved-candidate lapse. This
// module answers one narrow, offline question — "would the DECIDE model, under this DRAFT playbook,
// have entered any of these real recorded FLAT-position market states" — by replaying the exact
// recorded payload strings through ONE live call per row, in plan mode (submit_plan), the same
// request shape the live decide path sends. It is UNABLE to mint or promote anything itself: the
// caller (reflection.service.ts) is the only place a veto or a pass is acted on.

// Illustrative default profile for the replay's system prompt — the floor asks a structural
// question ("does this playbook's entry bar ever fire"), not "what is the strategy's live fee tier
// right now", so an exact runtime profile isn't required for the prompt to be representative. Mirrors
// anthropic-agent-client.ts's own DEFAULT_TRADING_PROFILE / test/eval/agentic/fixtures.ts's
// EVAL_PROFILE (redefined here, not imported — the eval fixture lives under test/, and this file is
// production code the eval harness itself may one day reuse in the other direction).
const DEFAULT_FLOOR_PROFILE: AgentTradingProfile = {
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

// Only the field the floor cares about — 'long' means the entry bar fired. A full planSchema parse
// (anthropic-agent-client.ts) isn't needed: the floor never places an order, it only counts.
const floorActionSchema = z.object({ action: z.enum(['long', 'flat', 'hold']) });

export interface EntryRateFloorConfig {
  readonly apiKey: string;
  // The DECIDE model, not the reflection model — the floor's question is "would the model that
  // actually trades enter under this playbook", never "would the (often pricier, Opus) reflection
  // model enter" (see reflection.service.ts's own comment on this distinction).
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  readonly playbookContent: string;
  // Always true today (the floor only ever replays the plan-mode request shape) — kept as an
  // explicit literal rather than a bare boolean so a future legacy-path replay would have to be a
  // deliberate, reviewed type change, not a silent behavior flip.
  readonly planMode: true;
  readonly minEdgeMultiple: string;
  readonly minRr: string;
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

  const systemPrompt = buildSystemPrompt(DEFAULT_FLOOR_PROFILE, {
    planMode: true,
    minEdgeMultiple: cfg.minEdgeMultiple,
    minRr: cfg.minRr,
  });
  const playbookBlock = buildPlaybookBlock(cfg.playbookContent);

  let consults = 0;
  let entries = 0;
  const usages: AgentUsage[] = [];

  for (const rowPayload of rows) {
    // W2.4-style cache split: the playbook block (the stable prefix shared by every row in this
    // batch) rides its own cache_control block; the volatile per-row market payload follows uncached
    // — same two-block layout as anthropic-agent-client.ts's own userContent.
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
          tools: [PLAN_TOOL],
          tool_choice: { type: 'tool', name: PLAN_TOOL.name },
          // Structured tool-use replay, not open-ended reasoning — disabled exactly like the live
          // decide call (anthropic-agent-client.ts's attemptOnce).
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const body: unknown = await res.json();
      const envelope = floorResponseSchema.safeParse(body);
      if (!envelope.success) continue;
      if (envelope.data.usage) {
        usages.push({
          inputTokens: envelope.data.usage.input_tokens,
          outputTokens: envelope.data.usage.output_tokens,
          cacheReadInputTokens: envelope.data.usage.cache_read_input_tokens,
          cacheCreationInputTokens: envelope.data.usage.cache_creation_input_tokens,
        });
      }
      const toolBlock = envelope.data.content?.find(
        (b) => b.type === 'tool_use' && b.name === PLAN_TOOL.name,
      );
      if (!toolBlock) continue;
      const parsed = floorActionSchema.safeParse(toolBlock.input);
      if (!parsed.success) continue;
      consults += 1;
      if (parsed.data.action === 'long') entries += 1;
    } catch {
      // Transport error / timeout / body-read failure — skip this row, never fail the whole floor.
      continue;
    } finally {
      clearTimeout(timer);
    }
  }

  return { consults, entries, usages };
}
