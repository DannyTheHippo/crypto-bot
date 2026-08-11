// Out-of-sample SESSION arm — prompt-surface EMITTER. Preregistered in
// research/studies/oos-session-arm-2026-08-03.md; the § 1a decide leg (docs/planning/daily-
// profitability-loop.md § 1a) dispatches a BLIND subagent whose entire input is the candidates
// file plus "the composed prompt surface (the same buildLiveSystemPrompt/buildPlaybookBlock output
// the harness itself builds — never hand-compose a different one)". VOID condition 2 voids the
// read on a system-prompt fidelity mismatch. Before this file existed there was no repo-tracked way
// to EMIT that surface to files a dispatched subagent can be handed, so each pass hand-rolled it —
// exactly the drift VOID condition 2 exists to catch. This module is that emitter, shipped as a
// permanent env-gated leg.
//
// Modelled on oos-arm-run.spec.ts's own env-gated-leg idiom: env-gated, skips CLEANLY when its gate
// is unset (`describe.runIf`), so `pnpm eval:oos-arm` / `pnpm eval:agentic` exercise this file's
// shape every run without ever writing a file. Gate: `OOS_ARM_EMIT_PROMPT=1`, plus
// `OOS_ARM_CANDIDATES_FILE` (the candidates JSON `pnpm loop:oos-gather` writes) and
// `OOS_ARM_EMIT_DIR` (an existing directory to write the four surface files into).
//
// FAILURE DIRECTION: this emitter FAILS CLOSED. A missing candidates file, an unreadable playbook,
// an empty system prompt, or a malformed tool schema THROWS, and every such check runs BEFORE the
// first `writeFileSync` call — nothing is written on a failed check. A silently truncated prompt
// surface handed to the blind subagent would void the read under VOID condition 2 without anyone
// noticing, so this module never writes a partial or best-effort surface.
//
// Reuses the repo's own builders rather than re-implementing or hand-composing the prompt surface
// itself: buildLiveSystemPrompt / agentPromptModuleFingerprint / sha256Hex (oos-arm-prompt.ts),
// buildPlaybookBlock (src/features/strategy/agentic/agent-prompt.ts). The candidates-file reader is
// the one exception: its only export is oos-arm-run.spec.ts's `readCandidatesFile`, and a VALUE
// import of a `.spec.ts` module re-executes that file's own top-level `describe()` calls inside
// THIS file's run — empirically verified: it turned this file's required clean skip (§ below) into
// "5 passed | 2 skipped", i.e. someone else's whole suite silently riding along. `readShapeFile`
// below is a byte-mirror of that reader's body; the SHAPE stays single-sourced via a `import type`
// (erased at compile time, so it carries no runtime module load and no describe side effects) — a
// future shape change there breaks this file's typecheck loudly rather than drifting silently.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OosArmCandidatesFile } from './oos-arm-run.spec';
import { buildLiveSystemPrompt, agentPromptModuleFingerprint, sha256Hex } from './oos-arm-prompt';
import { DEFAULT_FLOOR_PROFILE } from '../../../src/features/strategy/agentic/entry-rate-floor';
import { buildPlaybookBlock } from '../../../src/features/strategy/agentic/agent-prompt';

/** Byte-mirror of oos-arm-run.spec.ts's `readCandidatesFile` — see the header comment above for why
 * this is not a value import of that function. */
function readShapeFile(path: string): OosArmCandidatesFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as OosArmCandidatesFile;
  if (!Array.isArray(parsed.rows) || !Number.isFinite(parsed.gatheredAtMsFromDb)) {
    throw new Error(
      `readShapeFile: ${path} does not carry the expected {gatheredAtMsFromDb, playbookContent, ` +
        'rows} shape',
    );
  }
  return parsed;
}

// ── env-gated leg ───────────────────────────────────────────────────────────────────────────────
// Gate: OOS_ARM_EMIT_PROMPT=1, plus OOS_ARM_CANDIDATES_FILE and OOS_ARM_EMIT_DIR. Skips CLEANLY (no
// tests run under this describe) when the gate is unset — proven by running this file/`eval:oos-arm`
// with no env set, which is exactly what this repo's own validation does; this leg never fires there.
const EMIT = process.env['OOS_ARM_EMIT_PROMPT'] === '1';
const CANDIDATES_FILE = process.env['OOS_ARM_CANDIDATES_FILE'] ?? '';
const EMIT_DIR = process.env['OOS_ARM_EMIT_DIR'] ?? '';

describe.runIf(EMIT)('oos-arm-emit-prompt — emit the live-composed prompt surface to files', () => {
  it(
    'reads the candidates file, builds the exact live prompt surface, and writes it — fails ' +
      'closed on any malformed input, writing nothing on a failed check',
    () => {
      expect(CANDIDATES_FILE, 'OOS_ARM_CANDIDATES_FILE is required').not.toBe('');
      expect(EMIT_DIR, 'OOS_ARM_EMIT_DIR is required').not.toBe('');
      expect(existsSync(EMIT_DIR), `OOS_ARM_EMIT_DIR ${EMIT_DIR} must already exist`).toBe(true);

      const candidates = readShapeFile(CANDIDATES_FILE);
      const { systemPrompt, systemPromptSha256, toolSchemaJson, toolSchemaSha256 } =
        buildLiveSystemPrompt(DEFAULT_FLOOR_PROFILE);
      const playbookBlock = buildPlaybookBlock(candidates.playbookContent);
      const fingerprint = agentPromptModuleFingerprint();

      // Every check below runs BEFORE the first write (module header's FAILURE DIRECTION) — a
      // malformed surface throws here and nothing lands in OOS_ARM_EMIT_DIR.
      expect(systemPrompt.length, 'systemPrompt is suspiciously short').toBeGreaterThan(500);
      const parsedToolSchema: unknown = JSON.parse(toolSchemaJson);
      expect(
        parsedToolSchema,
        'toolSchemaJson must parse to an object with a name property',
      ).toHaveProperty('name');
      expect(playbookBlock.length, 'playbookBlock is empty').toBeGreaterThan(0);
      expect(systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(toolSchemaSha256).toMatch(/^[0-9a-f]{64}$/);

      const systemPromptPath = join(EMIT_DIR, 'oos-system-prompt.txt');
      const playbookBlockPath = join(EMIT_DIR, 'oos-playbook-block.txt');
      const toolSchemaPath = join(EMIT_DIR, 'oos-tool-schema.json');
      const hashesPath = join(EMIT_DIR, 'oos-surface-hashes.json');

      writeFileSync(systemPromptPath, systemPrompt, 'utf8');
      writeFileSync(playbookBlockPath, playbookBlock, 'utf8');
      writeFileSync(toolSchemaPath, toolSchemaJson, 'utf8');
      writeFileSync(
        hashesPath,
        JSON.stringify(
          {
            systemPromptSha256,
            toolSchemaSha256,
            playbookContentSha256: sha256Hex(playbookBlock),
            agentPromptCommitSha: fingerprint.commitSha,
            agentPromptBlobSha: fingerprint.worktreeBlobSha,
            candidatesFile: CANDIDATES_FILE,
            rowCount: candidates.rows.length,
            gatheredAtMsFromDb: candidates.gatheredAtMsFromDb,
            emittedAtIso: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );

      for (const path of [systemPromptPath, playbookBlockPath, toolSchemaPath, hashesPath]) {
        expect(existsSync(path), `${path} was not written`).toBe(true);
        expect(readFileSync(path, 'utf8').length, `${path} is empty`).toBeGreaterThan(0);
      }

      // The one line the dispatching pass records in its LOG entry.
      console.log(
        `oos-arm-emit-prompt: wrote ${systemPromptPath}, ${playbookBlockPath}, ${toolSchemaPath}, ` +
          `${hashesPath} — systemPromptSha256=${systemPromptSha256.slice(0, 16)} ` +
          `toolSchemaSha256=${toolSchemaSha256.slice(0, 16)}`,
      );
    },
  );
});
