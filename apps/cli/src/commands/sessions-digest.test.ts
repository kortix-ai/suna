import { describe, expect, test } from 'bun:test';
import { compactLogMessage } from './sessions-digest.ts';

describe('compactLogMessage — a session-log message as one compact digest row', () => {
  const message = (blocks: unknown[], over: Record<string, unknown> = {}) =>
    ({
      schema: 'kortix.session/2', v: 1, message_id: 'msg_a1', thread_id: 'ses_root', seq: 1,
      role: 'assistant', kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
      finish: 'stop', error: null, created_at: '2026-10-19T10:00:00.000Z', completed_at: '2026-10-19T10:00:05.000Z',
      producer: { harness: 'opencode', harness_version: '1', adapter_version: '1' }, blocks, ...over,
    }) as never;

  test('text joined and compacted, tool names with status, files, reasoning omitted, no tool input or output', () => {
    const row = compactLogMessage(
      message([
        { id: 'r', type: 'reasoning', text: 'thinking' },
        { id: 't1', type: 'text', text: 'Hello\n\n  world' },
        { id: 's', type: 'text', text: 'injected', synthetic: true },
        { id: 'c', type: 'tool_call', call_id: 'c1', name: 'bash', kind: 'shell', input: { command: 'ls' }, status: 'complete', result: { content: [{ type: 'text', text: 'secret output' }] } },
        { id: 'f', type: 'attachment', mime: 'text/plain', name: 'notes.txt', ref: 'kortix-attachment://p/s/a' },
      ]),
      700,
    );
    expect(row).toEqual({
      role: 'assistant',
      created: '2026-10-19T10:00:00.000Z',
      completed: '2026-10-19T10:00:05.000Z',
      text: 'Hello world',
      tools: [{ tool: 'bash', status: 'complete' }],
      files: [{ filename: 'notes.txt', mime: 'text/plain' }],
      reasoning_omitted: true,
      error: null,
    });
  });

  test('text over the limit is cut with an ellipsis; an errored message carries its error', () => {
    const row = compactLogMessage(message([{ id: 't', type: 'text', text: 'x'.repeat(100) }], { status: 'error', error: { code: 'APIError', message: 'rate limited' } }), 80);
    expect(row.text).toHaveLength(80);
    expect(row.text.endsWith('…')).toBe(true);
    expect(row.error?.message).toContain('rate limited');
  });
});
