import { describe, expect, test } from 'bun:test';
import { compactLogMessage, sanitizeTranscript } from './sessions-digest.ts';

describe('sanitizeTranscript', () => {
  test('carries the served source and completeness verbatim', () => {
    const t = sanitizeTranscript(
      {
        available: true,
        reason: 'session is stopped; live transcript requires a running sandbox',
        source: 'mirror',
        complete: true,
        opencode_session_id: 'ses_root',
        message_count: 2,
        messages: [{ role: 'assistant', text: 'stored' }],
      },
      null,
    );
    expect(t.available).toBe(true);
    expect(t.source).toBe('mirror');
    expect(t.complete).toBe(true);
    // The API attaches that sentence to a SUCCESSFUL mirror read. It is a note
    // on where the rows came from, never a refusal — the digest used to read
    // it as one and never made the request at all.
    expect(t.reason).toContain('requires a running sandbox');
    expect(t.message_count).toBe(2);
  });

  test('a saved transcript that stops short is not reported as complete', () => {
    const t = sanitizeTranscript(
      { available: true, source: 'mirror', complete: false, messages: [] },
      null,
    );
    expect(t.source).toBe('mirror');
    expect(t.complete).toBe(false);
  });

  test('an API that names neither field claims nothing it cannot prove', () => {
    // A CLI newer than its host. `source` is inferred only as far as the
    // response already proves — it served rows, so they are live — and
    // completeness is never assumed.
    const served = sanitizeTranscript({ available: true, messages: [{ role: 'user' }] }, 'ses_fb');
    expect(served.source).toBe('live');
    expect(served.complete).toBe(false);
    expect(served.opencode_session_id).toBe('ses_fb');

    const empty = sanitizeTranscript({ available: false, reason: 'nope' }, null);
    expect(empty.source).toBe('none');
    expect(empty.complete).toBe(false);
  });

  test('the runtime session is served neutrally, and under its pre-W4 key', () => {
    // A W4 API names it `runtime_session_id` (wins); an older one only `opencode_session_id`.
    const neutral = sanitizeTranscript(
      { available: true, runtime_session_id: 'ses_new', opencode_session_id: 'ses_old' },
      null,
    );
    expect(neutral.runtime_session_id).toBe('ses_new');
    expect(neutral.opencode_session_id).toBe('ses_new');
    const older = sanitizeTranscript({ available: true, opencode_session_id: 'ses_old' }, null);
    expect(older.runtime_session_id).toBe('ses_old');
  });

  test('a garbage body degrades to an unavailable transcript, never a crash', () => {
    const t = sanitizeTranscript('not an object', 'ses_fb');
    expect(t).toMatchObject({
      available: false,
      source: 'none',
      complete: false,
      opencode_session_id: 'ses_fb',
      message_count: 0,
      messages: [],
    });
  });
});

describe('compactLogMessage — a session-log message as one compact digest row (session_log on)', () => {
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
