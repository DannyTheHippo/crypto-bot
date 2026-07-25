// Single source for the v2 decision contract's stop-loss upper bound (capped below the 0.06
// disaster-backstop level — see CLAUDE.md § Conflict resolutions). Hoisted to domain (pure, no
// impure imports) so BOTH the config-side cross-field refusal (environment.config.ts's superRefine:
// PROTECT_STOP_LOSS_PCT must clear this bound before the bot-side backstop can ever be the FIRST
// line to fire) and the client-side tool schema (agent-prompt.ts's DECISION_V2_BOUNDS) read the same
// number — a hand-duplicated pair could drift and silently reopen the backstop-fires-before-the-
// model's-own-worst-case-stop gap.
export const AGENTIC_MAX_STOP_LOSS_PCT = '0.05';
