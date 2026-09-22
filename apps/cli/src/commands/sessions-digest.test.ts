import { describe, expect, test } from 'bun:test';
import { sanitizeTranscript } from './sessions-digest.ts';

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
