import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix, type SessionTranscriptSyncEnvelope } from '@kortix/sdk';

import { readSavedCopy } from './saved-copy';

/**
 * Opening a session on mobile showed a loader for the whole wake of its
 * computer (up to minutes), although the server holds a saved copy of the
 * conversation. `@kortix/sdk` paints the copy; these tests pin the read this
 * app makes for it, and the proof of an empty conversation.
 */

const ROOT = 'ses_root_1';
const originalFetch = globalThis.fetch;

function envelope(count: number, root = ROOT, capturedAt = '2026-09-26T10:00:00Z'): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: capturedAt,
    opencode_session_id: root,
    message_count: count,
    messages: Array.from({ length: count }, (_, i) => ({
      info: { id: `msg_${i + 1}`, sessionID: root, role: i % 2 === 0 ? 'user' : 'assistant', time: { created: i + 1 } },
      parts: [{ id: `prt_${i + 1}`, type: 'text', text: `message ${i + 1}` }],
    })),
  } as unknown as SessionTranscriptSyncEnvelope;
}

beforeEach(() => {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('readSavedCopy', () => {
  test('answers the server copy of this session', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json(envelope(3));
    }) as unknown as typeof fetch;

    const read = await readSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT });

    expect(read.envelope?.message_count).toBe(3);
    expect(read.empty).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/projects/p1/sessions/s1/transcript');
  });

  test('a failed read answers nothing, and never throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await readSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).toEqual({
      envelope: null,
      empty: false,
    });
  });

  test('without ids nothing is read', async () => {
    const fetchMock = mock(async () => Response.json(envelope(1)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect((await readSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: '' })).envelope).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('a sub-agent thread', () => {
  // A sub-agent runs in its own runtime session inside the Kortix session.
  // Its view waited for the computer; the server saves its transcript too.
  const CHILD = 'ses_child_1';

  test('reads its own saved window, and never claims emptiness', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json({ ...envelope(0, CHILD), total: 0 });
    }) as unknown as typeof fetch;

    const read = await readSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: CHILD, child: true });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`child=${CHILD}`);
    expect(read.envelope?.opencode_session_id).toBe(CHILD);
    expect(read.empty).toBe(false);
  });
});

describe('an empty conversation', () => {
  // The server's saved copy proves the conversation empty: a complete read of
  // the runtime found no messages. With no turn ever and none open there is
  // nothing to wait for, so the view opens on its composer.
  const provenEmpty = { ...envelope(0), total: 0 };
  const serve = (turn: unknown) => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      return url.includes('/turn') ? Response.json(turn) : Response.json(provenEmpty);
    }) as unknown as typeof fetch;
    return urls;
  };
  const empty = async () => (await readSavedCopy({ projectId: 'p1', sessionId: 's1', rootId: ROOT })).empty;

  test('a copy that proves this root empty, and no turn on record, is empty', async () => {
    serve({ turns: [] });
    expect(await empty()).toBe(true);
  });

  test('a turn that ended since, or one open, outranks the empty copy', async () => {
    serve({ turns: [], last_ended: { turn_token: 't1', end_reason: 'completed', ended_at: '2026-09-28T00:00:00Z' } });
    expect(await empty()).toBe(false);
    serve({ turns: [{ turn_token: 't2', state: 'running' }] });
    expect(await empty()).toBe(false);
  });

  test('an unanswered turn record is an unknown, never an empty', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/turn')) throw new TypeError('Network request failed');
      return Response.json(provenEmpty);
    }) as unknown as typeof fetch;
    expect(await empty()).toBe(false);
  });

  test('no saved copy is not evidence, and the turn record is not read for it', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Response.json({ ...envelope(0), available: false, source: 'none' });
    }) as unknown as typeof fetch;
    expect(await empty()).toBe(false);
    expect(urls.some((url) => url.includes('/turn'))).toBe(false);
  });
});
