import { describe, expect, test } from 'bun:test';

import { acpToolCallToPart, acpToolName, coerceElicitationAnswers } from './tool-part';
import type { AcpToolCall } from './transcript';

function tool(overrides: Partial<AcpToolCall>): AcpToolCall {
  return {
    id: 'call-1',
    title: 'Tool call',
    toolKind: null,
    status: 'completed',
    content: [],
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    data: {},
    ...overrides,
  };
}

describe('acpToolName', () => {
  const cases: Array<[string, AcpToolCall, string]> = [
    ['execute/terminal → bash', tool({ title: 'Execute command', toolKind: 'execute' }), 'bash'],
    ['terminal hint → bash', tool({ title: 'Run in terminal', toolKind: 'terminal' }), 'bash'],
    ['shell/command/bash hint → bash', tool({ title: 'Shell' }), 'bash'],
    ['apply patch → apply_patch', tool({ title: 'Apply patch', toolKind: 'diff' }), 'apply_patch'],
    ['write/create → write', tool({ title: 'Create file' }), 'write'],
    ['edit/replace → edit', tool({ title: 'Replace text' }), 'edit'],
    ['read/view → read', tool({ title: 'Read file' }), 'read'],
    ['glob/find files → glob', tool({ title: 'Find files' }), 'glob'],
    ['search/grep → grep', tool({ title: 'Grep repo' }), 'grep'],
    ['fetch/http/web → webfetch', tool({ title: 'Fetch URL' }), 'webfetch'],
  ];

  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(acpToolName(input)).toBe(expected);
    });
  }

  test('falls back to explicit tool.data.tool when no hint matches', () => {
    expect(acpToolName(tool({ title: 'Mystery step', data: { tool: 'custom_tool' } }))).toBe('custom_tool');
  });

  test('falls back to explicit tool.data.name when no hint matches and no data.tool', () => {
    expect(acpToolName(tool({ title: 'Mystery step', data: { name: 'named_tool' } }))).toBe('named_tool');
  });

  test('falls back to acp_tool when nothing matches and no explicit name', () => {
    expect(acpToolName(tool({ title: 'Mystery step', data: {} }))).toBe('acp_tool');
  });

  // ─── W4 / B12: a harness that declares its own tool name (the MCP-style
  // `rawInput: { name, arguments }` wrapper codex uses) must keep that
  // identity. Otherwise a free-text substring match on the title hijacks it —
  // codex's `write_stdin` (a PTY-poll tool, NOT a file write) was read as
  // `'write'` because its title contains "write", vanishing from both cards.
  // Real DB-verified shape from session `8023ee8f…`. ────────────────────────
  test("codex's MCP-wrapped write_stdin keeps its declared name, is NOT a file write", () => {
    const call = tool({
      title: 'write_stdin',
      toolKind: 'other',
      rawInput: { name: 'write_stdin', arguments: { session_id: 3700, yield_time_ms: 1000, max_output_tokens: 4000 } },
    });
    expect(acpToolName(call)).toBe('write_stdin');
    expect(acpToolName(call)).not.toBe('write');
  });

  test('a harness-declared rawInput.name wins over a title/kind hint', () => {
    // Even a title that reads like a shell command yields to an explicit name.
    expect(acpToolName(tool({ title: 'run in terminal', rawInput: { name: 'custom_pty', arguments: {} } }))).toBe('custom_pty');
  });

  test('a genuine file write (title Write, real path in rawInput) still classifies as write', () => {
    expect(
      acpToolName(tool({ title: 'Write', toolKind: 'edit', rawInput: { file_path: '/workspace/a.py', content: 'x' } })),
    ).toBe('write');
  });

  test('a genuine edit (title Edit, real path) still classifies as edit', () => {
    expect(
      acpToolName(tool({ title: 'Edit .gitignore', toolKind: 'edit', rawInput: { file_path: '/workspace/.gitignore', new_string: 'y', old_string: 'x' } })),
    ).toBe('edit');
  });

  test('an execute call whose rawInput carries a command (no declared name) is still bash', () => {
    expect(acpToolName(tool({ title: 'curl -I http://127.0.0.1:4173/', toolKind: 'execute', rawInput: { command: 'curl -I http://127.0.0.1:4173/' } }))).toBe('bash');
  });

  // ─── W4 / Mechanism 3: a native web search must land in the `web` family,
  // not be claimed by the generic `/search|grep/` check first. But a
  // NON-web "search"-flavored title (codex/Claude's MCP `ToolSearch`,
  // `kind: 'other'`) must stay `grep`/explore — it is not web. ──────────────
  test('a native web search resolves to websearch, not grep', () => {
    expect(acpToolName(tool({ title: 'Web Search', toolKind: 'search' }))).toBe('websearch');
  });

  test("a non-web ToolSearch (kind other) stays grep — the web reorder must not over-route it", () => {
    expect(acpToolName(tool({ title: 'ToolSearch', toolKind: 'other' }))).toBe('grep');
  });
});

describe('acpToolCallToPart', () => {
  test('does not carry host fields (sessionID/messageID/type)', () => {
    const part = acpToolCallToPart(tool({}));
    expect(part).not.toHaveProperty('sessionID');
    expect(part).not.toHaveProperty('messageID');
    expect(part).not.toHaveProperty('type');
    expect(part.id).toBe('acp-tool:call-1');
    expect(part.callID).toBe('call-1');
  });

  test('string input maps to {command} for bash', () => {
    const part = acpToolCallToPart(tool({ title: 'Execute command', rawInput: 'pwd' }));
    expect(part.tool).toBe('bash');
    expect(part.state.input).toEqual({ command: 'pwd' });
  });

  test('string input maps to {value} for non-bash tools', () => {
    const part = acpToolCallToPart(tool({ title: 'Read file', rawInput: 'a.ts' }));
    expect(part.tool).toBe('read');
    expect(part.state.input).toEqual({ value: 'a.ts' });
  });

  test('location path maps to {filePath} when no rawInput is present', () => {
    const part = acpToolCallToPart(tool({ title: 'Read file', locations: [{ path: '/workspace/README.md' }] }));
    expect(part.state.input).toEqual({ filePath: '/workspace/README.md' });
  });

  test('location uri is used when path is absent', () => {
    const part = acpToolCallToPart(tool({ title: 'Read file', locations: [{ uri: 'file:///workspace/README.md' }] }));
    expect(part.state.input).toEqual({ filePath: 'file:///workspace/README.md' });
  });

  test('object rawInput passes through unchanged', () => {
    const input = { command: 'false', flag: true };
    const part = acpToolCallToPart(tool({ title: 'Execute command', rawInput: input }));
    expect(part.state.input).toEqual(input);
  });

  test('snake_case file_path (Claude Code wire shape) gains the canonical filePath alias, original key kept', () => {
    const part = acpToolCallToPart(tool({ title: 'Read file', rawInput: { file_path: '/workspace/README.md' } }));
    expect(part.state.input).toEqual({ file_path: '/workspace/README.md', filePath: '/workspace/README.md' });
  });

  test('object rawInput without a path falls back to the first location for filePath', () => {
    const part = acpToolCallToPart(tool({
      title: 'Read file',
      rawInput: { offset: 10 },
      locations: [{ path: '/workspace/a.ts', line: 1 }],
    }));
    expect(part.state.input).toEqual({ offset: 10, filePath: '/workspace/a.ts' });
  });

  test('an explicit filePath is never overridden by aliases or locations', () => {
    const part = acpToolCallToPart(tool({
      title: 'Read file',
      rawInput: { filePath: '/keep/me.ts', file_path: '/other.ts' },
      locations: [{ path: '/loc.ts' }],
    }));
    expect(part.state.input.filePath).toBe('/keep/me.ts');
  });

  test('sandbox process plumbing (Chunk ID / Wall time / session ID / Output:) is stripped, real output kept', () => {
    const wrapped = [
      'Chunk ID: ddbbf1',
      'Wall time: 1.0005 seconds',
      'Process running with session ID 16120',
      'Original token count: 0',
      'Output:',
      '/workspace',
      'total 24',
    ].join('\n');
    const part = acpToolCallToPart(tool({ title: 'Execute command', rawOutput: { formatted_output: wrapped } }));
    expect(part.state.output).toBe('/workspace\ntotal 24');
  });

  test('a plumbing-only payload (process produced nothing) collapses to empty output', () => {
    const wrapped = [
      'Chunk ID: 000fcb',
      'Wall time: 1.0035 seconds',
      'Process running with session ID 24452',
      'Original token count: 0',
      'Output:',
    ].join('\n');
    const part = acpToolCallToPart(tool({ title: 'Execute command', rawOutput: { formatted_output: wrapped } }));
    expect(part.state.output).toBe('');
  });

  test('ordinary output without a Chunk ID header passes through untouched', () => {
    const part = acpToolCallToPart(tool({ title: 'Execute command', rawOutput: 'Wall time: is a phrase\nreal line' }));
    expect(part.state.output).toBe('Wall time: is a phrase\nreal line');
  });

  test('structured rawOutput surfaces its human-readable text, never a JSON dump', () => {
    const part = acpToolCallToPart(tool({
      title: 'Execute command',
      rawOutput: { formatted_output: 'hello from pwd', exit_code: 0 },
    }));
    expect(part.state.output).toBe('hello from pwd');
  });

  test('nested content blocks resolve to their text; diff blocks never flatten into output text', () => {
    const part = acpToolCallToPart(tool({
      title: 'Read file',
      content: [
        { type: 'content', content: { type: 'text', text: 'file body' } },
        { type: 'diff', path: '/a.ts', oldText: 'x', newText: 'y' },
      ],
    }));
    expect(part.state.output).toBe('file body');
  });

  test('empty input when no rawInput and no usable location', () => {
    const part = acpToolCallToPart(tool({ title: 'Mystery step' }));
    expect(part.state.input).toEqual({});
  });

  describe('status mapping', () => {
    const cases: Array<[string | null, 'pending' | 'running' | 'completed' | 'error']> = [
      ['failed', 'error'],
      ['error', 'error'],
      ['completed', 'completed'],
      ['in_progress', 'running'],
      ['running', 'running'],
      ['pending', 'pending'],
      [null, 'pending'],
      ['unknown-status', 'pending'],
    ];
    for (const [status, expected] of cases) {
      test(`status ${String(status)} → ${expected}`, () => {
        const part = acpToolCallToPart(tool({ status }));
        expect(part.state.status).toBe(expected);
      });
    }
  });

  test('keeps ACP input, output, locations, and errors losslessly available on failure', () => {
    const input = { command: 'false' };
    const location = { path: '/workspace/task.ts', line: 8 };
    const part = acpToolCallToPart(tool({
      status: 'failed',
      rawInput: input,
      rawOutput: { stderr: 'failed' },
      locations: [location],
      data: { vendor: 'codex' },
    }));

    expect(part.state.status).toBe('error');
    // Enriched, not mutated: the original keys survive alongside the
    // canonical `filePath` alias derived from the reported location.
    expect(part.state.input).toEqual({ ...input, filePath: location.path });
    expect(part.state.output).toContain('failed');
    expect(part.state.error).toContain('failed');
    expect(part.state.metadata).toEqual({ locations: [location], acp: { vendor: 'codex' } });
  });

  test('falls back to a generic error message when there is no output text', () => {
    const part = acpToolCallToPart(tool({ title: 'Execute command', status: 'failed' }));
    expect(part.state.error).toBe('Execute command failed');
  });

  test('derives output from content blocks when rawOutput is empty', () => {
    const part = acpToolCallToPart(tool({
      rawOutput: undefined,
      content: [{ type: 'text', text: 'README.md' }],
    }));
    expect(part.state.output).toBe('README.md');
  });

  test('prefers rawOutput text over content when both are present', () => {
    const part = acpToolCallToPart(tool({
      rawOutput: '/workspace',
      content: [{ type: 'text', text: 'ignored' }],
    }));
    expect(part.state.output).toBe('/workspace');
  });
});

describe('coerceElicitationAnswers', () => {
  const schema = (properties: Record<string, unknown>) => ({ requestedSchema: { type: 'object', properties } });

  test('boolean property: "true" → true', () => {
    const result = coerceElicitationAnswers({ confirm: 'true' }, schema({ confirm: { type: 'boolean' } }));
    expect(result).toEqual({ confirm: true });
  });

  test('boolean property: "false" → false', () => {
    const result = coerceElicitationAnswers({ confirm: 'false' }, schema({ confirm: { type: 'boolean' } }));
    expect(result).toEqual({ confirm: false });
  });

  test('number property coerces to a numeric value', () => {
    const result = coerceElicitationAnswers({ count: '42' }, schema({ count: { type: 'number' } }));
    expect(result).toEqual({ count: 42 });
  });

  test('integer property coerces to a numeric value', () => {
    const result = coerceElicitationAnswers({ count: '7' }, schema({ count: { type: 'integer' } }));
    expect(result).toEqual({ count: 7 });
  });

  test('non-finite numeric answer passes through as the original string', () => {
    const result = coerceElicitationAnswers({ count: 'not-a-number' }, schema({ count: { type: 'integer' } }));
    expect(result).toEqual({ count: 'not-a-number' });
  });

  test('string property passes through unchanged', () => {
    const result = coerceElicitationAnswers({ name: 'hello' }, schema({ name: { type: 'string' } }));
    expect(result).toEqual({ name: 'hello' });
  });

  test('enum-typed property (no explicit type) passes through as a string', () => {
    const result = coerceElicitationAnswers({ env: 'dev' }, schema({ env: { title: 'Env', enum: ['dev'] } }));
    expect(result).toEqual({ env: 'dev' });
  });

  test('keys absent from the schema pass through unchanged', () => {
    const result = coerceElicitationAnswers({ untracked: 'value' }, schema({}));
    expect(result).toEqual({ untracked: 'value' });
  });

  test('missing requestedSchema passes every answer through unchanged', () => {
    const result = coerceElicitationAnswers({ a: 'true', b: '42' }, {});
    expect(result).toEqual({ a: 'true', b: '42' });
  });

  test('non-record answers guard returns an empty object', () => {
    expect(coerceElicitationAnswers(null as unknown as Record<string, string>, {})).toEqual({});
    expect(coerceElicitationAnswers(undefined as unknown as Record<string, string>, {})).toEqual({});
    expect(coerceElicitationAnswers([] as unknown as Record<string, string>, {})).toEqual({});
  });
});
