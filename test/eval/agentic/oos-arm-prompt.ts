// Out-of-sample SESSION arm — system-prompt / fidelity module. Preregistered in
// research/studies/oos-session-arm-2026-08-03.md § VOID conditions (condition 2: "System-prompt
// fidelity mismatch ... Mismatch VOIDS this read").
//
// Builds the EXACT system prompt the LIVE lane composes today (same buildSystemPrompt call the live
// client makes — anthropic-agent-client.ts:1588 — with the SAME flag values the live deployment
// carries, read off .env.app, the single source for deploy knobs per root CLAUDE.md's env-sync
// rule) and checks that every optional payload block a RECORDED row carries has a corresponding live
// flag turned on. A mismatch means this decide leg would compose a system prompt that does not
// document a block the row's own payload carries (or the reverse) — a different prompt surface than
// live sends on that row, which is exactly what VOID condition 2 exists to catch.
//
// FAILURE DIRECTION: checkPromptFidelity FAILS CLOSED — an unparseable payload, or a payload block
// present without its live flag on, is a violation, never silently accepted. This is a VOID-condition
// gate protecting the read's validity, not a measurement that must stay available at any cost.

import { createHash } from 'node:crypto';
import {
  buildSystemPrompt,
  buildTradeTool,
  type BuildSystemPromptOptions,
} from '../../../src/features/strategy/agentic/agent-prompt';
import type { AgentTradingProfile } from '../../../src/ports/strategy/agentic-strategy';
// Reuses playbook-space-replay.ts's own git-blob probe (peer-owned, READ-ONLY import — never
// edited) rather than forking a second git shell-out: checkPromptSurface computes runSha/
// worktreeBlob generically off PROMPT_SURFACE_FILE; its own INCUMBENT_PROMPT_BLOB comparison is a
// DIFFERENT study's pin and is ignored here — only the two raw fields are read.
import { checkPromptSurface } from './playbook-space-replay';

/**
 * The live deployment's own feed flags, verified against `.env.app` (and, where a flag has no
 * dedicated env key, against the wiring in agentic-strategy.module.ts) on 2026-08-03 — NOT copied
 * from the dispatch brief's "nine of eleven" figure, which undercounts: `fundingHistoryFeedEnabled`
 * is wired to the SAME `DERIVATIVES_FEED_ENABLED` env var as `derivativesFeedEnabled`
 * (agentic-strategy.module.ts:581, "no new env knob — task ask was 'gated behind the existing
 * derivatives feed flag'"), so it is actually TRUE live, not false. Ten of thirteen flags are true;
 * a future `.env.app` drift is a real risk this module cannot detect on its own — see this file's
 * own spec for the "flags echo .env.app" pin, which is what would catch that drift.
 */
export const LIVE_FEED_FLAGS: Required<BuildSystemPromptOptions> = {
  derivativesFeedEnabled: true, // .env.app:204 DERIVATIVES_FEED_ENABLED=true
  derivativesV2Enabled: false, // AGENTIC_DERIVATIVES_V2_ENABLED absent from .env.app -> schema default false
  fundingHistoryFeedEnabled: true, // agentic-strategy.module.ts:581 reuses DERIVATIVES_FEED_ENABLED (true)
  sentimentFeedEnabled: false, // .env.app:231 SENTIMENT_FEED_ENABLED=false
  fearGreedFeedEnabled: true, // .env.app:232 FEAR_GREED_FEED_ENABLED=true
  crossSymbolFeedEnabled: true, // .env.app:219 AGENTIC_CROSS_SYMBOL_ENABLED=true
  tradeFlowFeedEnabled: true, // .env.app:238 AGENTIC_TRADEFLOW_ENABLED=true
  positioningFeedEnabled: true, // .env.app:242 AGENTIC_POSITIONING_ENABLED=true
  liquidationsFeedEnabled: true, // .env.app:247 AGENTIC_LIQUIDATIONS_ENABLED=true
  bookStructureFeedEnabled: true, // .env.app:250 AGENTIC_BOOK_STRUCTURE_ENABLED=true
  trackRecordFeedEnabled: true, // .env.app:253 AGENTIC_TRACK_RECORD_ENABLED=true
  edgePolicyFeedEnabled: true, // .env.app:255 AGENTIC_EDGE_POLICY_ENABLED=true
  episodicMemoryEnabled: false, // AGENTIC_EPISODIC_MEMORY_ENABLED absent from .env.app -> agentic-strategy.module.ts:2580 default false
};

/**
 * Payload block key (buildMarketPayload's own JSON keys, agent-prompt.ts:1283-1380) -> the
 * BuildSystemPromptOptions flag that gates the system-prompt sentence documenting it. Exhaustive
 * against agent-prompt.ts as read on 2026-08-03 (12 of the 13 LIVE_FEED_FLAGS entries carry a
 * distinct block; `derivativesV2Enabled` is a SWITCH within the `derivatives` block, not a block of
 * its own — see DERIVATIVES_V2_TEMPLATE_VERSION's own comment in agent-prompt.ts).
 */
export const FEED_BLOCK_TO_FLAG: Readonly<Record<string, keyof BuildSystemPromptOptions>> = {
  derivatives: 'derivativesFeedEnabled',
  fundingHistory: 'fundingHistoryFeedEnabled',
  sentiment: 'sentimentFeedEnabled',
  fearGreed: 'fearGreedFeedEnabled',
  crossSymbol: 'crossSymbolFeedEnabled',
  tradeFlow: 'tradeFlowFeedEnabled',
  positioning: 'positioningFeedEnabled',
  liquidation: 'liquidationsFeedEnabled',
  bookStructure: 'bookStructureFeedEnabled',
  trackRecord: 'trackRecordFeedEnabled',
  edgePolicy: 'edgePolicyFeedEnabled',
  similarSetups: 'episodicMemoryEnabled',
};

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface LiveSystemPrompt {
  readonly systemPrompt: string;
  readonly systemPromptSha256: string;
  readonly toolSchemaJson: string;
  readonly toolSchemaSha256: string;
}

/** The exact system prompt + tool schema this decide leg sends — built from LIVE_FEED_FLAGS, never
 * from the replay engine's own DEFAULT (all-off) options (see this study's header brief on the
 * fidelity gap `playbook-space-replay.ts:1480`'s `buildSystemPrompt(DEFAULT_FLOOR_PROFILE)` call
 * carries — this module exists specifically to not inherit that gap). */
export function buildLiveSystemPrompt(profile: AgentTradingProfile): LiveSystemPrompt {
  const systemPrompt = buildSystemPrompt(profile, LIVE_FEED_FLAGS);
  const toolSchemaJson = JSON.stringify(buildTradeTool());
  return {
    systemPrompt,
    systemPromptSha256: sha256Hex(systemPrompt),
    toolSchemaJson,
    toolSchemaSha256: sha256Hex(toolSchemaJson),
  };
}

export interface AgentPromptFingerprint {
  readonly commitSha: string;
  readonly worktreeBlobSha: string;
}

/** VOID condition 2's "the read records the agent-prompt.ts blob hash next to its own commit SHA" —
 * fails OPEN to empty strings on an unreadable git tree (checkPromptSurface's own documented
 * direction), because this is a provenance annotation, not a permission gate. */
export function agentPromptModuleFingerprint(cwd = process.cwd()): AgentPromptFingerprint {
  const surface = checkPromptSurface(cwd);
  return { commitSha: surface.runSha, worktreeBlobSha: surface.worktreeBlob };
}

export interface PromptFidelityResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * VOID condition 2 (system-prompt fidelity mismatch). FAILS CLOSED: an unparseable payload, or a
 * payload block present without its live flag turned on, is a violation — never silently accepted.
 */
export function checkPromptFidelity(rowInputPayload: string): PromptFidelityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowInputPayload);
  } catch {
    return { ok: false, violations: ['row payload is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, violations: ['row payload is not a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;
  const violations: string[] = [];
  for (const [blockKey, flagKey] of Object.entries(FEED_BLOCK_TO_FLAG)) {
    if (obj[blockKey] !== undefined && !LIVE_FEED_FLAGS[flagKey]) {
      violations.push(
        `payload carries "${blockKey}" but the live flag ${flagKey} is false — the composed system ` +
          `prompt would not document this block, a different prompt surface than live sends on this row`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}
