import { describe, expect, test } from 'bun:test';

import { MIRROR_WINDOW_MAX_CHARS, type MirrorSnapshot } from './session-transcript-mirror';

const { buildSessionTranscriptDigest, buildSessionTranscriptSyncEnvelope, mirrorIsComplete } =
  await import('./session-transcript');

const session = (status: string) =>
  ({
    sessionId: 'sess-1',
    status,
    runtimeSessionId: 'ses_pin',
    sandboxUrl: null,
  }) as never;

function snapshot(over: Partial<MirrorSnapshot> = {}): MirrorSnapshot {
  return {
    opencode_session_id: 'ses_mirror',
    captured_at: '2026-08-26T06:00:00.000Z',
    total: 2,
    head_complete: true,
    next_cursor: null,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
        parts: [{ id: 'p1', type: 'text', text: 'ping' }],
      },
      {
        info: {
          id: 'msg_2',
          role: 'assistant',
          parentID: 'msg_1',
          time: { created: 1100, completed: 1200 },
        },
        parts: [
          { id: 'p2', type: 'text', text: 'pong' },
          { id: 'p3', type: 'tool', tool: 'bash', state: { status: 'completed' } },
        ],
      },
    ],
    ...over,
  };
}

const build = (status: string, mirror: MirrorSnapshot | null) =>
  buildSessionTranscriptDigest(
    {
      session: session(status),
      limit: 40,
      maxChars: 700,
    },
    { readMirror: async () => mirror },
  );

describe('the digest is the stored session log, for a running or a stopped session', () => {
  test('source is "mirror", available is true, and the messages carry their ids', async () => {
    // THE BUG THIS CLOSES: every non-running session returned
    // `available:false, messages:[]`, so opening a hibernated session showed a
    // full-screen "Connecting…" with no transcript for the whole wake.
    const digest = await build('stopped', snapshot());
    expect(digest.available).toBe(true);
    expect(digest.source).toBe('mirror');
    expect(digest.message_count).toBe(2);
    expect(digest.messages.map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
    expect(digest.messages.map((m) => m.text)).toEqual(['ping', 'pong']);
    expect(digest.messages[1].parent_id).toBe('msg_1');
    expect(digest.messages[1].completed).toBe(new Date(1200).toISOString());
    expect(digest.captured_at).toBe('2026-08-26T06:00:00.000Z');
    expect(digest.opencode_session_id).toBe('ses_mirror');
    expect(digest.runtime_session_id).toBe('ses_mirror');
  });

  test('a running session reads the same stored copy, with no reason', async () => {
    const digest = await build('running', snapshot());
    expect(digest).toMatchObject({ available: true, source: 'mirror', reason: null, message_count: 2 });
  });

  test('a tool call survives the mirror round trip', async () => {
    const digest = await build('stopped', snapshot());
    expect(digest.messages[1].tools).toEqual([{ tool: 'bash', status: 'completed' }]);
  });
});

describe('with no mirror, the old honest answer is unchanged', () => {
  test('source is "none" and available stays false', async () => {
    // A negative is a claim. "Nothing was ever captured" must not render as an
    // empty-but-complete thread.
    const digest = await build('stopped', null);
    expect(digest.available).toBe(false);
    expect(digest.source).toBe('none');
    expect(digest.complete).toBe(false);
    expect(digest.messages).toEqual([]);
    expect(digest.reason).toBe('nothing is saved for this session yet');
    expect(digest.opencode_session_id).toBe('ses_pin');
    expect(digest.runtime_session_id).toBe('ses_pin');
  });
});

describe('complete is derived from evidence, never assumed', () => {
  test('head proven AND the whole mirror returned', () => {
    expect(mirrorIsComplete(snapshot({ head_complete: true, total: 2 }))).toBe(true);
  });

  test('head NOT proven means not complete, however many rows came back', () => {
    expect(mirrorIsComplete(snapshot({ head_complete: false, total: 2 }))).toBe(false);
  });

  test('a windowed read of a longer mirror is not complete', () => {
    expect(mirrorIsComplete(snapshot({ head_complete: true, total: 400 }))).toBe(false);
  });

  test('the digest carries that verdict through', async () => {
    expect((await build('stopped', snapshot({ head_complete: false }))).complete).toBe(false);
    expect((await build('stopped', snapshot({ head_complete: true, total: 2 }))).complete).toBe(
      true,
    );
  });
});

describe('the sync envelope is the mirror and says so', () => {
  test('it returns OpenCode message envelopes verbatim', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40 },
      { readMirror: async () => snapshot() },
    );
    expect(envelope.source).toBe('mirror');
    expect(envelope.available).toBe(true);
    expect(envelope.complete).toBe(true);
    // Verbatim: `time.completed` is what tells the client the turn ENDED.
    expect(envelope.messages[1].info).toEqual({
      id: 'msg_2',
      role: 'assistant',
      parentID: 'msg_1',
      time: { created: 1100, completed: 1200 },
    });
    expect(envelope.messages[1].parts).toHaveLength(2);
  });

  test('nothing captured is "none", not an empty transcript', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('running'), limit: 40 },
      { readMirror: async () => null },
    );
    expect(envelope.available).toBe(false);
    expect(envelope.source).toBe('none');
    expect(envelope.messages).toEqual([]);
  });

  test('a mirror that proved the conversation empty is an available, complete, empty transcript', async () => {
    // A complete read of the runtime found no messages. Clients open such a
    // session on its composer instead of waiting for its computer.
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40 },
      { readMirror: async () => snapshot({ head_complete: true, total: 0, messages: [] }) },
    );
    expect(envelope).toMatchObject({ available: true, source: 'mirror', complete: true, total: 0, messages: [] });
  });
});

describe('a window says how much it is a window OF', () => {
  test('the envelope carries the mirror total and the cursor to the older window', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 2 },
      { readMirror: async () => snapshot({ total: 242, next_cursor: 'msg_1' }) },
    );
    // `complete: false` says the window is partial. Without these two the
    // client cannot say by how much, and cannot reach the rest at all.
    expect(envelope.complete).toBe(false);
    expect(envelope.message_count).toBe(2);
    expect(envelope.total).toBe(242);
    expect(envelope.next_cursor).toBe('msg_1');
  });

  test('a window that reaches the oldest row offers no cursor', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40 },
      { readMirror: async () => snapshot() },
    );
    expect(envelope.complete).toBe(true);
    expect(envelope.total).toBe(2);
    expect(envelope.next_cursor).toBeNull();
  });

  test('the cursor reaches the reader, so the older window is a different read', async () => {
    const asked: Array<string | null | undefined> = [];
    await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, before: 'msg_1' },
      {
        readMirror: async (_id, _limit, before) => {
          asked.push(before);
          return snapshot();
        },
      },
    );
    expect(asked).toEqual(['msg_1']);
  });

  test('an unavailable mirror still answers the two fields', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('running'), limit: 40 },
      { readMirror: async () => null },
    );
    expect(envelope.total).toBe(0);
    expect(envelope.next_cursor).toBeNull();
  });
});

describe('a window is bounded by size as well as by count', () => {
  // Rows keep every tool call 1:1, so 40 messages of a tool-heavy thread can
  // weigh megabytes. The first window is what a cold open waits for.
  const heavy = (id: string, created: number, chars: number) => ({
    info: { id, role: 'assistant', time: { created, completed: created + 1 } },
    parts: [
      {
        id: `p_${id}`,
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: '/workspace/a.ts' },
          output: 'X'.repeat(chars),
          time: { start: 1, end: 2 },
        },
      },
    ],
  });

  test('an oversized window keeps its NEWEST messages and pages the rest', async () => {
    const chars = Math.floor(MIRROR_WINDOW_MAX_CHARS * 0.4);
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40 },
      {
        readMirror: async () =>
          snapshot({
            total: 5,
            next_cursor: null,
            messages: [1, 2, 3, 4, 5].map((n) => heavy(`m${n}`, n, chars)),
          }),
      },
    );
    expect(envelope.messages.map((m) => m.info.id)).toEqual(['m4', 'm5']);
    expect(envelope.message_count).toBe(2);
    // The older window starts strictly behind the oldest message served.
    expect(envelope.next_cursor).toBe('m4');
    expect(envelope.complete).toBe(false);
    expect(envelope.total).toBe(5);
  });

  test('one message over the budget is served alone, so paging always moves', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, before: 'm3' },
      {
        readMirror: async () =>
          snapshot({
            total: 3,
            next_cursor: null,
            messages: [heavy('m1', 1, 10), heavy('m2', 2, MIRROR_WINDOW_MAX_CHARS * 2)],
          }),
      },
    );
    expect(envelope.messages.map((m) => m.info.id)).toEqual(['m2']);
    expect(envelope.next_cursor).toBe('m2');
  });

  test('a window within the budget keeps its own cursor', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 2 },
      { readMirror: async () => snapshot({ total: 242, next_cursor: 'msg_1' }) },
    );
    expect(envelope.messages.map((m) => m.info.id)).toEqual(['msg_1', 'msg_2']);
    expect(envelope.next_cursor).toBe('msg_1');
  });
});

describe("a sub-agent's saved transcript is its own window", () => {
  test('the child id reaches the reader, and the window names the child', async () => {
    const asked: Array<string | null | undefined> = [];
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, child: 'ses_child' },
      {
        readMirror: async (_id, _limit, _before, opencodeSessionId) => {
          asked.push(opencodeSessionId);
          return snapshot({ opencode_session_id: 'ses_child' });
        },
      },
    );
    expect(asked).toEqual(['ses_child']);
    expect(envelope.available).toBe(true);
    expect(envelope.opencode_session_id).toBe('ses_child');
    expect(envelope.runtime_session_id).toBe('ses_child');
  });

  test('a root read asks for the root, never a child', async () => {
    const asked: Array<string | null | undefined> = [];
    await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40 },
      {
        readMirror: async (_id, _limit, _before, opencodeSessionId) => {
          asked.push(opencodeSessionId);
          return snapshot();
        },
      },
    );
    expect(asked).toEqual([null]);
  });

  test('a child nothing was saved for is unavailable, not an empty transcript', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, child: 'ses_child' },
      { readMirror: async () => null },
    );
    expect(envelope.available).toBe(false);
    expect(envelope.source).toBe('none');
    expect(envelope.opencode_session_id).toBe('ses_child');
    expect(envelope.runtime_session_id).toBe('ses_child');
  });
});

describe('early history requires the current server-owned root', () => {
  test('a replaced root cannot seed a stale transcript before the runtime starts', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, requireCurrentRoot: true },
      { readMirror: async () => snapshot() },
    );
    expect(envelope.available).toBe(false);
    expect(envelope.messages).toEqual([]);
    expect(envelope.opencode_session_id).toBe('ses_pin');
    expect(envelope.runtime_session_id).toBe('ses_pin');
  });
  test('a matching root serves completed messages without reading the runtime', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, requireCurrentRoot: true },
      { readMirror: async () => snapshot({ opencode_session_id: 'ses_pin' }) },
    );
    expect(envelope.available).toBe(true);
    expect(envelope.messages[1].info.time).toEqual({ created: 1100, completed: 1200 });
  });
});
