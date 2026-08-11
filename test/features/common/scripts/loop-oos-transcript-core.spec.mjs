import { describe, it, expect } from 'vitest';
import {
  extractToolCalls,
  classifyBlindness,
  buildAttestation,
} from '../../../../scripts/loop-oos-transcript-core.mjs';

// The out-of-sample SESSION arm's VOID-4 (blindness) evidence gate — pure classifier only. Synthetic
// fixtures throughout; zero real transcripts, zero writes under research/ (the shell, not this suite,
// touches research/oos-arm/attestations.jsonl). See loop-oos-transcript-core.mjs's own header for why
// this fails CLOSED rather than OPEN like the measurement cores elsewhere in this repo.

function toolUseLine({ name, input, lineType = 'tool_use', content = null }) {
  const block = content ?? [{ type: lineType, name, input, id: `toolu_${name}` }];
  return JSON.stringify({ message: { content: block } });
}

describe('extractToolCalls', () => {
  it('finds tool_use blocks across multiple lines and reports lineCount', () => {
    const jsonl = [
      toolUseLine({ name: 'Read', input: { file_path: '/a.txt' } }),
      toolUseLine({ name: 'Bash', input: { command: 'ls /tmp' } }),
    ].join('\n');
    const { toolCalls, lineCount, unparseableLines, unknownBlocks } = extractToolCalls(jsonl);
    expect(lineCount).toBe(2);
    expect(unparseableLines).toEqual([]);
    expect(unknownBlocks).toEqual([]);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      lineIndex: 0,
      blockType: 'tool_use',
      name: 'Read',
      input: { file_path: '/a.txt' },
    });
    expect(toolCalls[1]).toMatchObject({
      lineIndex: 1,
      blockType: 'tool_use',
      name: 'Bash',
      input: { command: 'ls /tmp' },
    });
  });

  it('ignores lines whose message.content is not an array (plain text / attachment records)', () => {
    const jsonl = [
      JSON.stringify({ message: { content: 'a plain string message' } }),
      JSON.stringify({ attachment: { type: 'deferred_tools_delta' } }),
      toolUseLine({ name: 'Read', input: { file_path: '/a.txt' } }),
    ].join('\n');
    const { toolCalls, lineCount, unparseableLines } = extractToolCalls(jsonl);
    expect(lineCount).toBe(3);
    expect(unparseableLines).toEqual([]);
    expect(toolCalls).toHaveLength(1);
  });

  it('collects an unparseable line rather than throwing', () => {
    const jsonl = [
      toolUseLine({ name: 'Read', input: { file_path: '/a.txt' } }),
      'this is not json {{{',
      toolUseLine({ name: 'Bash', input: { command: 'ls /tmp' } }),
    ].join('\n');
    expect(() => extractToolCalls(jsonl)).not.toThrow();
    const { toolCalls, lineCount, unparseableLines } = extractToolCalls(jsonl);
    expect(lineCount).toBe(3);
    expect(unparseableLines).toEqual([1]);
    expect(toolCalls).toHaveLength(2);
  });

  it('skips blank lines without counting them', () => {
    const jsonl = `${toolUseLine({ name: 'Read', input: { file_path: '/a.txt' } })}\n\n`;
    const { lineCount } = extractToolCalls(jsonl);
    expect(lineCount).toBe(1);
  });

  it('non-tool_use, non-tool_result content blocks (e.g. text) carry no tool call and are not unknown', () => {
    const jsonl = toolUseLine({
      content: [{ type: 'text', text: "I'll read the four permitted files." }],
    });
    const { toolCalls, unknownBlocks } = extractToolCalls(jsonl);
    expect(toolCalls).toEqual([]);
    expect(unknownBlocks).toEqual([]);
  });

  it('a plain tool_result block is inert and carries no tool call', () => {
    const jsonl = toolUseLine({
      content: [{ type: 'tool_result', tool_use_id: 'toolu_Read', content: 'file contents' }],
    });
    const { toolCalls, unknownBlocks } = extractToolCalls(jsonl);
    expect(toolCalls).toEqual([]);
    expect(unknownBlocks).toEqual([]);
  });

  it('a server_tool_use block (harness-injected advisor tool) is extracted as a tool call with its real blockType', () => {
    const jsonl = toolUseLine({
      content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }],
    });
    const { toolCalls, unknownBlocks } = extractToolCalls(jsonl);
    expect(unknownBlocks).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      lineIndex: 0,
      blockType: 'server_tool_use',
      name: 'advisor',
      input: {},
    });
  });

  it('an advisor_tool_result block is inert and does not itself become a tool call, but the preceding server_tool_use still becomes a toolCall', () => {
    const jsonl = [
      toolUseLine({
        content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }],
      }),
      toolUseLine({
        content: [
          { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: 'advisor reply' },
        ],
      }),
    ].join('\n');
    const { toolCalls, unknownBlocks } = extractToolCalls(jsonl);
    expect(unknownBlocks).toEqual([]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      lineIndex: 0,
      blockType: 'server_tool_use',
      name: 'advisor',
    });
  });

  it('an unrecognised block type is surfaced in unknownBlocks rather than dropped', () => {
    const jsonl = toolUseLine({ content: [{ type: 'future_thing', payload: 'x' }] });
    const { toolCalls, unknownBlocks } = extractToolCalls(jsonl);
    expect(toolCalls).toEqual([]);
    expect(unknownBlocks).toEqual([{ lineIndex: 0, blockType: 'future_thing' }]);
  });

  it('a block with no type string is surfaced in unknownBlocks', () => {
    const jsonl = toolUseLine({ content: [{ text: 'no type field at all' }] });
    const { unknownBlocks } = extractToolCalls(jsonl);
    expect(unknownBlocks).toEqual([{ lineIndex: 0, blockType: null }]);
  });
});

const ALLOWED_PATHS = ['/scratch/oos/system-prompt.txt', '/scratch/oos/candidates.json'];

describe('classifyBlindness', () => {
  it('allowed Read of an allowed path is clean', () => {
    const toolCalls = [
      { lineIndex: 0, blockType: 'tool_use', name: 'Read', input: { file_path: ALLOWED_PATHS[0] } },
    ];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict).toMatchObject({ clean: true, violations: [], allowedCount: 1 });
  });

  it('Read of a path NOT in allowedPaths is a violation', () => {
    const toolCalls = [
      { lineIndex: 0, blockType: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
    ];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatchObject({
      lineIndex: 0,
      name: 'Read',
      reason: 'path_not_allowed',
    });
  });

  it.each(['Write', 'Edit', 'NotebookEdit'])(
    '%s is governed by the same allowedPaths rule as Read',
    (name) => {
      const clean = classifyBlindness({
        toolCalls: [
          { lineIndex: 0, blockType: 'tool_use', name, input: { file_path: ALLOWED_PATHS[1] } },
        ],
        unparseableLines: [],
        unknownBlocks: [],
        allowedPaths: ALLOWED_PATHS,
      });
      expect(clean.clean).toBe(true);

      const dirty = classifyBlindness({
        toolCalls: [
          { lineIndex: 0, blockType: 'tool_use', name, input: { file_path: '/elsewhere.json' } },
        ],
        unparseableLines: [],
        unknownBlocks: [],
        allowedPaths: ALLOWED_PATHS,
      });
      expect(dirty.clean).toBe(false);
    },
  );

  it('Grep (or any other unrecognised tool) is a violation, unconditionally', () => {
    const toolCalls = [
      { lineIndex: 0, blockType: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
    ];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations[0]).toMatchObject({ name: 'Grep', reason: 'disallowed_tool' });
  });

  it.each(['Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__foo__bar'])(
    '%s is always a violation',
    (name) => {
      const verdict = classifyBlindness({
        toolCalls: [{ lineIndex: 0, blockType: 'tool_use', name, input: {} }],
        unparseableLines: [],
        unknownBlocks: [],
        allowedPaths: ALLOWED_PATHS,
      });
      expect(verdict.clean).toBe(false);
      expect(verdict.violations[0].reason).toBe('disallowed_tool');
    },
  );

  it('Bash is a violation even when its command touches only an allowed path — no allowlist survives', () => {
    const toolCalls = [
      {
        lineIndex: 0,
        blockType: 'tool_use',
        name: 'Bash',
        input: { command: `cat ${ALLOWED_PATHS[1]}` },
      },
    ];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations[0]).toMatchObject({ name: 'Bash', reason: 'disallowed_tool' });
  });

  it('a toolCall whose blockType is not tool_use (server-side/injected) is a violation even for an allowed-looking name', () => {
    const toolCalls = [{ lineIndex: 0, blockType: 'server_tool_use', name: 'advisor', input: {} }];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations[0]).toMatchObject({
      lineIndex: 0,
      name: 'advisor',
      reason: 'non_client_tool_call',
    });
    expect(verdict.violations[0].detail).toContain('server_tool_use');
  });

  it('every unknownBlocks entry is a violation, reason unknown_block_type', () => {
    const verdict = classifyBlindness({
      toolCalls: [],
      unparseableLines: [],
      unknownBlocks: [{ lineIndex: 2, blockType: 'future_thing' }],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations).toContainEqual(
      expect.objectContaining({ lineIndex: 2, reason: 'unknown_block_type' }),
    );
  });

  it('an unparseable line forces clean=false even when all tool calls are fine', () => {
    const toolCalls = [
      { lineIndex: 0, blockType: 'tool_use', name: 'Read', input: { file_path: ALLOWED_PATHS[0] } },
    ];
    const verdict = classifyBlindness({
      toolCalls,
      unparseableLines: [3],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict.clean).toBe(false);
    expect(verdict.violations).toContainEqual(
      expect.objectContaining({ lineIndex: 3, reason: 'unparseable_line' }),
    );
    // The genuinely clean tool call must not itself be double-counted as a violation.
    expect(verdict.violations).toHaveLength(1);
  });

  it('zero tool calls is clean — a subagent that answered inline read nothing', () => {
    const verdict = classifyBlindness({
      toolCalls: [],
      unparseableLines: [],
      unknownBlocks: [],
      allowedPaths: ALLOWED_PATHS,
    });
    expect(verdict).toMatchObject({ clean: true, violations: [], allowedCount: 0 });
  });

  it('throws on a missing/omitted toolCalls rather than defaulting to clean', () => {
    expect(() =>
      classifyBlindness({
        unparseableLines: [],
        unknownBlocks: [],
        allowedPaths: ALLOWED_PATHS,
      }),
    ).toThrow(/toolCalls/);
  });

  it('throws on a non-array unparseableLines', () => {
    expect(() =>
      classifyBlindness({
        toolCalls: [],
        unparseableLines: null,
        unknownBlocks: [],
        allowedPaths: ALLOWED_PATHS,
      }),
    ).toThrow(/unparseableLines/);
  });

  it('throws on a non-array unknownBlocks', () => {
    expect(() =>
      classifyBlindness({
        toolCalls: [],
        unparseableLines: [],
        unknownBlocks: undefined,
        allowedPaths: ALLOWED_PATHS,
      }),
    ).toThrow(/unknownBlocks/);
  });

  it('throws on an empty allowedPaths — there is no offered surface to check against', () => {
    expect(() =>
      classifyBlindness({
        toolCalls: [],
        unparseableLines: [],
        unknownBlocks: [],
        allowedPaths: [],
      }),
    ).toThrow(/allowedPaths/);
  });
});

describe('buildAttestation', () => {
  it('emits schemaVersion 2 and the renamed, host-path-free fields', () => {
    const fields = {
      passLabel: 'pass 68',
      firing: 1,
      agentId: 'af2b50ff6292ce0af',
      sessionId: '27ad6271-295a-48ec-94a7-ba0789b65fee',
      agentType: 'general-purpose',
      model: 'claude-opus-5',
      transcriptPathFromHome: '.claude/projects/slug/session/subagents/agent-af2b.jsonl',
      pathBase: 'home',
      projectSlugSuffix: 'crypto-bot',
      transcriptSha256: 'deadbeef',
      transcriptBytes: 4096,
      lineCount: 21,
      toolCallCount: 5,
      allowedFiles: ['system-prompt.txt', 'candidates.json'],
      allowedBase: '<session-scratch>',
      blindnessClean: true,
      violations: [],
      capturedAtIso: '2026-08-11T00:00:00.000Z',
      rowIds: ['67602', '67603'],
    };
    const attestation = buildAttestation(fields);
    expect(attestation.schemaVersion).toBe(2);
    expect(attestation).not.toHaveProperty('transcriptPath');
    expect(attestation).not.toHaveProperty('allowedPaths');
    for (const [key, value] of Object.entries(fields)) {
      expect(attestation[key]).toEqual(value);
    }
  });
});
