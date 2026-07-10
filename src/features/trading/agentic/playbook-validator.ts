import { PLAYBOOK_BLOCK_START, PLAYBOOK_BLOCK_END } from './agent-prompt';

// Structural gate for a stored playbook before it's ever composed into a prompt: this is the real
// defense (the playbook is untrusted, previously-model-authored content). It must look exactly
// like a 4-section playbook and carry nothing that could escape its quoted DATA framing in
// buildUserMessage — no code fence, no occurrence of the block delimiters themselves, no stray
// markdown heading. It says nothing about the CONTENT being safe advice.
const REQUIRED_SECTIONS = [
  'regime notes',
  'entry rules',
  'exit rules',
  'mistakes to avoid',
] as const;
const REQUIRED_HEADING_RE = /^##\s+(regime notes|entry rules|exit rules|mistakes to avoid)\s*$/i;
const MAX_PLAYBOOK_CHARS = 4000;
// Control chars other than \n (0x0A): C0 controls (incl. \t, \r), DEL.
const CONTROL_CHAR_RE = /[\x00-\x09\x0B-\x1F\x7F]/;
const CODE_FENCE = '```';

// Prompt-hygiene tripwire only — NOT a claimed security boundary. The structural gate above is the
// real defense; a denylist over free-form text is trivially bypassable (paraphrase, encoding,
// splitting across lines) and exists only to flag obviously-suspicious playbook content for the
// tripwire metric.
//
// Matching is by WORD-BOUNDARY / CONCEPT-PHRASE regex, not raw substring (`lower.includes`).
// Rationale (2026-07-10, Pass 13): the prior substring form hard-rejected benign trading prose —
// "marginal" tripped `margin`, "leverage the trend" tripped `leverage`, "let the EMA act as support"
// tripped `act as`, "when you are now holding" tripped `you are now` — which killed EVERY reflection
// candidate (2/2 validator_reject observed live; playbook pinned at the net-negative v1 seed, so the
// learning loop could never advance). W2's remedy — "keep the validator dumb, warn the model off the
// words in the prompt" — was empirically FALSIFIED: buildReflectionSystemPrompt already warns these
// sequences and Opus emitted them anyway. So the fix moved here: match the dangerous CONCEPT instead
// of any substring of it. This is PRECISION, not polarity-awareness — a cautionary "do not use
// leverage" still contains the phrase "use leverage" and is still rejected (see the pinned spec). The
// matcher is shared by the write side (reflection mint) and the read side (compose-into-prompt via
// AnthropicAgentClient + ValidatingPlaybookProvider), so the two can never diverge; every
// injection/exfil pattern hard-blocks on both.
const BANNED_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  // ── Prompt-injection / instruction-override ─────────────────────────────────────────────────────
  {
    label: 'ignore previous',
    re: /\bignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instruction|message|prompt|rule|direction|command|context|guidance)/i,
  },
  { label: 'system prompt', re: /\bsystem\s+prompt\b/i },
  { label: 'developer message', re: /\bdeveloper\s+(?:message|instruction)\b/i },
  {
    label: 'new instructions',
    re: /\b(?:your|the\s+following|here\s+are(?:\s+the)?|below\s+are(?:\s+the)?|obey(?:\s+the)?|follow(?:\s+the)?|these)\s+new\s+instructions?\b|\bnew\s+instructions?\s*:/i,
  },
  {
    label: 'override the rules',
    re: /\boverride\s+(?:the\s+|these\s+|your\s+|all\s+)?(?:rules?|instructions?|constraints?|limits?)\b/i,
  },
  {
    label: 'disregard instructions',
    re: /\bdisregard\s+(?:the\s+|all\s+|any\s+|these\s+|prior\s+|previous\s+|above\s+|your\s+)*(?:instruction|rule|guidance|direction|command|message|prompt|constraint|everything\b|the\s+above)/i,
  },
  {
    label: 'you are now',
    re: /\byou\s+are\s+now\s+(?:a\b|an\b|the\b|acting\b|operating\b|running\b|permitted\b|allowed\b|authori[sz]ed\b|able\b|free\b|unrestricted\b|unlocked\b|jailbroken\b|in\s+(?:developer|dev|god|admin|debug|jailbreak)\b|no\s+longer\b)/i,
  },
  {
    label: 'act as',
    re: /\bact\s+as\s+(?:a\b|an\b|the\b|if\s+you\b|though\s+you\b|root\b|admin(?:istrator)?\b|superuser\b|developer\b|system\b|dan\b|god\b)/i,
  },
  { label: 'jailbreak', re: /\bjailbreak/i },
  {
    label: 'bypass risk',
    re: /\bbypass\s+(?:the\s+|all\s+)?(?:risk|safety|guard|control|check|limit)/i,
  },
  // ── Credential / fund exfiltration ──────────────────────────────────────────────────────────────
  { label: 'api key', re: /\bapi[\s-]?key\b/i },
  {
    label: 'withdraw',
    // `*` (not `?`) tolerates stacked qualifiers/adjectives between the verb and the noun
    // ("withdraw all your funds", "withdraw the entire balance") — a bare-verb match is still avoided
    // (benign "buyers withdraw" has no fund-noun after) so the fund-exfil concept, not the word, gates.
    re: /\bwithdraw(?:al)?\s+(?:(?:all|the|your|our|my|its|entire|remaining|available|any|some|max|maximum|full)\s+)*(?:fund|money|balance|capital|profit|asset|coin|token|holding|to\b|everything\b)/i,
  },
  // ── Non-spot / dangerous trading directives the spot long/flat lane must never adopt ────────────
  {
    label: 'leverage',
    // Verb collocates ("apply/increase/add/use/… leverage") and "leverage of N" reject the directive;
    // the bare verb sense ("leverage the trend/momentum") is intentionally NOT matched.
    re: /\b(?:(?:use|using|apply|applying|add|adding|increase|increasing|reduce|reducing|more|higher|maximum|max|with)\s+(?:the\s+|your\s+)?leverage|leveraged\b|\d+\s*x\s+leverage|leverage\s+(?:up\b|of\b|the\s+(?:position|account|trade)|your\s+(?:position|account)|trading))/i,
  },
  {
    label: 'margin',
    re: /\b(?:on\s+margin|use\s+margin|using\s+margin|margin\s+(?:trading|account|call|loan|position)|borrow(?:ed|ing)?\s+to\s+(?:buy|trade))/i,
  },
  { label: 'sell short', re: /\bsell\s+short\b/i },
  { label: 'short position', re: /\bshort\s+(?:position|selling)\b|\bshort\s+the\s+market\b/i },
  {
    label: 'go short',
    re: /\bgo(?:ing)?\s+short\b|\bshort\s+(?:it|here|this)\b|\bshort\s+the\s+(?:top|high|rally)\b/i,
  },
  { label: 'live trading', re: /\blive[\s-]?trading\b|\blive\s+(?:money|capital|funds?)\b/i },
  { label: 'all-in', re: /\b(?:go\s+)?all[\s-]?in\b/i },
  {
    label: 'max out',
    re: /\bmax(?:imi[sz]e)?\s+out\s+(?:the\s+|your\s+|our\s+|all\s+|position|size|exposure|allocation|leverage|risk)/i,
  },
] as const;

export type PlaybookValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly bannedTokenHit?: boolean;
      // The matched pattern's stable label (bounded ~20-value set), for the low-cardinality tripwire
      // metric so a rejection's exact trigger is observable without the (ephemeral) warn log.
      readonly bannedToken?: string;
    };

export function validatePlaybook(content: string): PlaybookValidationResult {
  if (content.length > MAX_PLAYBOOK_CHARS) {
    return {
      ok: false,
      reason: `playbook exceeds ${MAX_PLAYBOOK_CHARS} chars (got ${content.length})`,
    };
  }
  if (CONTROL_CHAR_RE.test(content)) {
    return { ok: false, reason: 'playbook contains a non-printable control character' };
  }
  if (content.includes(CODE_FENCE)) {
    return { ok: false, reason: 'playbook contains a code fence' };
  }
  if (content.includes(PLAYBOOK_BLOCK_START) || content.includes(PLAYBOOK_BLOCK_END)) {
    return { ok: false, reason: 'playbook contains the reserved playbook-block delimiter' };
  }

  const foundHeadings: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('#')) continue;
    const match = REQUIRED_HEADING_RE.exec(line);
    if (!match) {
      return {
        ok: false,
        reason: `unexpected heading (only the 4 required "## " sections are allowed): "${line}"`,
      };
    }
    foundHeadings.push(match[1]!.toLowerCase());
  }
  const sectionsMatch =
    foundHeadings.length === REQUIRED_SECTIONS.length &&
    REQUIRED_SECTIONS.every((section, i) => foundHeadings[i] === section);
  if (!sectionsMatch) {
    return {
      ok: false,
      reason: `playbook must contain exactly these 4 sections, once each, in order: ${REQUIRED_SECTIONS.map((s) => `## ${s}`).join(', ')}`,
    };
  }

  for (const { label, re } of BANNED_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        reason: `playbook contains a denylisted concept: "${label}"`,
        bannedTokenHit: true,
        bannedToken: label,
      };
    }
  }

  return { ok: true };
}
