import { describe, expect, test } from 'bun:test';

import {
  buildSessionTranscriptDigest,
  buildSessionTranscriptSyncEnvelope,
  mirrorIsComplete,
} from './session-transcript';
import type { MirrorSnapshot } from './session-transcript-mirror';

const session = (status: string) =>
  ({
    sessionId: 'sess-1',
    status,
    opencodeSessionId: 'ses_pin',
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
      projectId: 'proj-1',
      accountId: 'acct-1',
      userId: 'user-1',
      limit: 40,
      maxChars: 700,
    },
    { readMirror: async () => mirror },
  );

describe('a stopped session serves the mirror instead of nothing', () => {
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
  });

  test('the reason still says WHY it is not live — the mirror does not hide it', async () => {
    const digest = await build('stopped', snapshot());
    expect(digest.reason).toBe('session is stopped; live transcript requires a running sandbox');
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
    expect(digest.reason).toBe('session is stopped; live transcript requires a running sandbox');
    expect(digest.opencode_session_id).toBe('ses_pin');
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

  test('an empty mirror is "none", not an empty transcript', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('running'), limit: 40 },
      { readMirror: async () => null },
    );
    expect(envelope.available).toBe(false);
    expect(envelope.source).toBe('none');
    expect(envelope.messages).toEqual([]);
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

describe('early history requires the current server-owned root', () => {
  test('a replaced root cannot seed a stale transcript before the runtime starts', async () => {
    const envelope = await buildSessionTranscriptSyncEnvelope(
      { session: session('stopped'), limit: 40, requireCurrentRoot: true },
      { readMirror: async () => snapshot() },
    );
    expect(envelope.available).toBe(false);
    expect(envelope.messages).toEqual([]);
    expect(envelope.opencode_session_id).toBe('ses_pin');
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
