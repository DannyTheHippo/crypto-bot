// Out-of-sample SESSION arm — VOID-4 (blindness) transcript CHECK, the pure decision core. No I/O, no
// clock, no process/env, no imports beyond node:crypto — mirrors the loop-sweep-core.mjs /
// loop-authoring-core.mjs split: every judgement here is unit-testable off a fixture, and the runner
// (loop-oos-transcript.mjs) only reads bytes and calls in.
//
// WHY THIS EXISTS. research/studies/oos-session-arm-2026-08-03.md's VOID condition 4 voids a read if
// "a transcript showing the deciding session read anything beyond the offered payload" exists. The
// 2026-08-10 amendment § 4 names the mechanism: the decide leg runs in a DISPATCHED SUBAGENT, and
// "that dispatched subagent's own transcript IS the VOID-4 artifact" — checked before a window is
// sealed, "never summarized, redacted, or regenerated". This module is that check. It is NOT the
// artifact: the harness-owned transcript at
// $HOME/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl remains the sole evidence,
// preserved verbatim, and this core (via the shell) only READS it in place and produces a small,
// separate ATTESTATION record that pins its bytes by sha256 and records the check's verdict.
//
// FAILURE DIRECTION — THIS IS A VOID-CONDITION EVIDENCE GATE, AND IT FAILS CLOSED. An unreadable
// transcript, an unparseable line, or a tool call this classifier does not positively recognise is a
// VIOLATION, never a silent pass — the opposite direction from the measurement cores elsewhere in this
// repo (loop-sweep-core.mjs, loop-oos-arm-core.mjs), which fail OPEN because a broken measurement must
// never block the thing it measures. This is not a measurement: it is the one procedural control the
// pre-registration names as sufficient to void an entire sealed window, so an ambiguous read must
// refuse the "clean" verdict rather than assume it.

/** Content-block types that never represent an action the transcript's own session took, so they carry
 * no tool call and are skipped without becoming an `unknownBlocks` finding. Verified 2026-08-11 against
 * 27 real `agent-<id>.jsonl` subagent transcripts under this repo's own `~/.claude/projects/` session
 * storage: every non-tool_use, non-tool_result-shaped block observed was one of `text` or `thinking`
 * (819 and 296 occurrences respectively across those files) — `image` and `redacted_thinking` are known
 * Anthropic content-block shapes not observed in this corpus but included defensively for the same
 * reason. A `*_tool_result` block (plain `tool_result`, 1333 occurrences, or the harness-injected
 * advisor tool's `advisor_tool_result`, 27 occurrences) is the RETURN of a call already captured — or
 * flagged — via its matching `*_tool_use` block, so it is inert by the same suffix rule that makes
 * `*_tool_use` a tool call below; it never itself represents an action the deciding session took. */
const INERT_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'tool_result',
  'image',
  'redacted_thinking',
]);

/**
 * Every tool-call content block out of a subagent transcript JSONL, in line order.
 *
 * Each line is one JSON object; a client tool call is an entry of `message.content[]` shaped
 * `{type:'tool_use', name, input, id}` — the harness's own subagent-transcript format. Real transcripts
 * also carry harness-injected non-client tool calls under a different type, e.g.
 * `{type:'server_tool_use', id, name, input}` for the `advisor` tool (29 occurrences across 23 of the 27
 * transcripts scanned 2026-08-11 — see `INERT_BLOCK_TYPES` above for the full scan). Any block whose
 * type string ends with `tool_use` — `tool_use` itself, `server_tool_use`, or an as-yet-unseen shape
 * like `mcp_tool_use` — is collected as a tool call, with its real block type preserved so
 * `classifyBlindness` can tell a client call from a server/injected one. A block that is NEITHER an
 * inert shape NOR a recognised tool-call shape is surfaced in `unknownBlocks` rather than dropped — an
 * unrecognised block shape fails CLOSED (see the header), it does not fail silently. Lines whose
 * `message.content` is not an array (e.g. a plain string content, an attachment record) carry no blocks
 * at all and are simply skipped — that is not the same as a PARSE failure, so it does not enter
 * `unparseableLines`.
 *
 * Never throws on a bad line: a line that is not valid JSON is collected into `unparseableLines`
 * instead, because an unreadable transcript is itself the finding this module exists to surface (see
 * the header) — a crash here would just trade one silent failure for another.
 * @returns {{
 *   toolCalls: Array<{lineIndex:number,blockType:string,name:string,input:object}>,
 *   lineCount:number,
 *   unparseableLines: number[],
 *   unknownBlocks: Array<{lineIndex:number,blockType:(string|null)}>,
 * }}
 */
export function extractToolCalls(jsonlText) {
  const lines = String(jsonlText ?? '').split('\n');
  const toolCalls = [];
  const unparseableLines = [];
  const unknownBlocks = [];
  let lineCount = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex];
    if (raw.trim() === '') continue;
    lineCount += 1;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      unparseableLines.push(lineIndex);
      continue;
    }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const blockType = block?.type;
      if (typeof blockType !== 'string') {
        unknownBlocks.push({ lineIndex, blockType: blockType ?? null });
        continue;
      }
      if (blockType.endsWith('tool_use')) {
        toolCalls.push({ lineIndex, blockType, name: block.name, input: block.input ?? {} });
        continue;
      }
      if (INERT_BLOCK_TYPES.has(blockType) || blockType.endsWith('tool_result')) {
        continue;
      }
      unknownBlocks.push({ lineIndex, blockType });
    }
  }
  return { toolCalls, lineCount, unparseableLines, unknownBlocks };
}

/**
 * The blindness verdict for one transcript's tool calls. FAILS CLOSED — see the header: anything not
 * positively recognised is a violation. Throws on a malformed precondition rather than defaulting to
 * clean (config/input refusal at the boundary, never a silent pass on an omitted or malformed field —
 * see rules/code-hygiene.md § Config refusal at construction).
 *
 * Rules:
 *  - Every entry in `unparseableLines` is a violation with reason `unparseable_line`: a transcript this
 *    check cannot fully read cannot certify blindness.
 *  - Every entry in `unknownBlocks` is a violation with reason `unknown_block_type`: a content-block
 *    shape this gate does not understand cannot certify blindness either.
 *  - A tool call whose `blockType` is not exactly `tool_use` (a server-side or harness-injected call,
 *    e.g. `server_tool_use`) is a violation with reason `non_client_tool_call` — these can pull outside
 *    information into the transcript without the deciding session ever issuing a client tool call.
 *  - `Read`/`Write`/`Edit`/`NotebookEdit`: allowed only when `input.file_path` is an EXACT member of
 *    `allowedPaths` — the offered-surface files the subagent was told it may read.
 *  - Every other tool name (`Bash`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `mcp__*`,
 *    …) is a violation, unconditionally, reason `disallowed_tool` — none of them are compatible with
 *    "read exactly the offered payload". `Bash` in particular is forbidden outright by the study's own
 *    dispatch brief; there is no path-based allowlist for it, because a text-token scan over a shell
 *    command cannot reliably rule out prefix escapes, missing-slash operands, or output redirection.
 *  - Zero tool calls is CLEAN: a subagent that answered inline, reading nothing, is trivially blind.
 * @returns {{clean:boolean, violations:Array<{lineIndex:number,name:(string|null),reason:string,detail:string}>, allowedCount:number}}
 */
export function classifyBlindness({ toolCalls, unparseableLines, unknownBlocks, allowedPaths }) {
  if (!Array.isArray(toolCalls)) {
    throw new TypeError(
      'classifyBlindness: toolCalls must be an array — an omitted toolCalls list must never silently certify clean',
    );
  }
  if (!Array.isArray(unparseableLines)) {
    throw new TypeError('classifyBlindness: unparseableLines must be an array');
  }
  if (!Array.isArray(unknownBlocks)) {
    throw new TypeError('classifyBlindness: unknownBlocks must be an array');
  }
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new TypeError(
      'classifyBlindness: allowedPaths must be a non-empty array — there is no offered surface to check tool calls against otherwise',
    );
  }

  const allowed = new Set(allowedPaths);
  const violations = [];
  let allowedCount = 0;

  for (const lineIndex of unparseableLines) {
    violations.push({
      lineIndex,
      name: null,
      reason: 'unparseable_line',
      detail:
        'this transcript line was not valid JSON — an unreadable transcript cannot certify blindness',
    });
  }

  for (const { lineIndex, blockType } of unknownBlocks) {
    violations.push({
      lineIndex,
      name: null,
      reason: 'unknown_block_type',
      detail: `content block of type ${JSON.stringify(blockType ?? null)} is neither a recognised inert shape nor a recognised tool-call shape — a transcript this gate does not understand cannot certify blindness`,
    });
  }

  for (const call of toolCalls) {
    const { lineIndex, blockType, name, input } = call;
    if (blockType !== 'tool_use') {
      violations.push({
        lineIndex,
        name,
        reason: 'non_client_tool_call',
        detail: `${name} was invoked as a ${JSON.stringify(blockType ?? null)} block, not a client tool_use — server-side or harness-injected tools can bring outside information into the transcript`,
      });
      continue;
    }
    if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
      if (typeof input?.file_path === 'string' && allowed.has(input.file_path)) {
        allowedCount += 1;
      } else {
        violations.push({
          lineIndex,
          name,
          reason: 'path_not_allowed',
          detail: `${name} on ${JSON.stringify(input?.file_path ?? null)}, which is not one of the offered-surface files`,
        });
      }
      continue;
    }
    violations.push({
      lineIndex,
      name,
      reason: 'disallowed_tool',
      detail: `${name} is never permitted in a blind decide leg`,
    });
  }

  return { clean: violations.length === 0, violations, allowedCount };
}

/**
 * Assembles the attestation record in a stable key order. This is an ADDITION to the repo, never a
 * replacement for the transcript it checks — see the header. `schemaVersion` is bumped whenever a
 * field is added, removed, or reinterpreted, so a later reader of an old row knows which shape to
 * expect without inferring it from which fields happen to be present.
 *
 * schemaVersion 2 (2026-08-11): the record must never embed an absolute host path or username (this
 * file is tracked in git — rules/code-hygiene.md § Secrets and paths). `transcriptPath` (an absolute
 * `/Users/<user>/...` path) is replaced by `transcriptPathFromHome` (the path relative to `$HOME`, with
 * the leading `-Users-<username>-` slug segment already stripped by the caller) plus `pathBase` naming
 * what the path is relative to when it is not under `$HOME`. `allowedPaths` (absolute scratch-dir
 * paths) is replaced by `allowedFiles` (basenames only) plus `allowedBase`, the literal token
 * `"<session-scratch>"` — the absolute scratch prefix is host-local and reconstructible from
 * `sessionId`, so it does not belong in a committed record. `projectSlugSuffix` (the repo directory
 * name only, e.g. `crypto-bot`) is added to carry project identity without the username-bearing slug
 * prefix. This function stays a pure assembler: the caller (the shell) computes every one of these
 * already-sanitised values before calling in — no `node:path`/`node:os` import belongs in this file.
 * @returns {object}
 */
export function buildAttestation({
  passLabel,
  firing,
  agentId,
  sessionId,
  agentType,
  model,
  transcriptPathFromHome,
  pathBase,
  projectSlugSuffix,
  transcriptSha256,
  transcriptBytes,
  lineCount,
  toolCallCount,
  allowedFiles,
  allowedBase,
  blindnessClean,
  violations,
  capturedAtIso,
  rowIds,
}) {
  return {
    schemaVersion: 2,
    passLabel,
    firing,
    agentId,
    sessionId,
    agentType,
    model,
    transcriptPathFromHome,
    pathBase,
    projectSlugSuffix,
    transcriptSha256,
    transcriptBytes,
    lineCount,
    toolCallCount,
    allowedFiles,
    allowedBase,
    blindnessClean,
    violations,
    capturedAtIso,
    rowIds,
  };
}
