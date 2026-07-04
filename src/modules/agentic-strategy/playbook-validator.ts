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
// tripwire metric a later task wires up.
const BANNED_TOKENS = [
  'ignore previous',
  'ignore all previous',
  'system prompt',
  'developer message',
  'new instructions',
  'disregard',
  'override the rules',
  'you are now',
  'act as',
  'jailbreak',
  'sell short',
  'short position',
  'leverage',
  'margin',
  'withdraw',
  'api key',
  'live trading',
  'bypass risk',
  'max out',
  'all-in',
] as const;

export type PlaybookValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly bannedTokenHit?: boolean };

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

  const lower = content.toLowerCase();
  for (const token of BANNED_TOKENS) {
    if (lower.includes(token)) {
      return {
        ok: false,
        reason: `playbook contains a denylisted token: "${token}"`,
        bannedTokenHit: true,
      };
    }
  }

  return { ok: true };
}
