import { describe, expect, test } from 'bun:test';
import { LIVE_TURN_PHASE_PAGE_LIMIT, liveTurnPhaseFromPage, readLiveTurnPhase } from './live-turn-phase';

const TURN = 'msg_A';

const user = (id: string) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text: 'q' }] });
const assistant = (
  id: string,
  parentID: string,
  parts: unknown[],
  completed?: number,
) => ({
  info: { id, role: 'assistant', parentID, time: { created: 1, ...(completed ? { completed } : {}) } },
  parts,
});
const tool = (status: string) => ({ type: 'tool', tool: 'bash', state: { status } });

describe('liveTurnPhaseFromPage', () => {
  test('a RUNNING or PENDING tool is a tool phase — a step boundary is seconds away', () => {
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'Let me check.' }, tool('running')])],
        TURN,
      ),
    ).toBe('tool');
    expect(liveTurnPhaseFromPage([user(TURN), assistant('a1', TURN, [tool('pending')])], TURN)).toBe(
      'tool',
    );
  });

  test('an open assistant message writing text, with no tool, is a text phase', () => {
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'step-start' }, { type: 'text', text: '# Pigeons\n' }])],
        TURN,
      ),
    ).toBe('text');
  });

  test('a text part OpenCode has OPENED but not yet persisted a character of is a text phase', () => {
    // Read from the OpenCode 1.18 bundle, 2026-09-21: `text-start` persists the
    // part as `{ text: '', time: { start } }`, every `text-delta` goes through
    // `updatePartDelta`, which is `publish(Event.PartDelta)` and nothing else,
    // and only `text-end` writes the text plus `time.end`. So for the whole
    // length of a streamed answer the REST page shows an EMPTY text part. A
    // classifier that waited for characters would call the owner's exact case
    // — a long markdown answer — "other", and steer into it.
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'step-start' }, { type: 'text', text: '', time: { start: 5 } }])],
        TURN,
      ),
    ).toBe('text');
  });

  test('an empty text part with no start instant is not evidence of anything', () => {
    expect(
      liveTurnPhaseFromPage([user(TURN), assistant('a1', TURN, [{ type: 'text', text: '' }])], TURN),
    ).toBe('other');
    expect(
      liveTurnPhaseFromPage([user(TURN), assistant('a1', TURN, [{ type: 'text', text: '   \n' }])], TURN),
    ).toBe('other');
  });

  test('a text part that has ENDED is not being written — the step is about to close on its own', () => {
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'Done.', time: { start: 5, end: 9 } }])],
        TURN,
      ),
    ).toBe('other');
  });

  test('a FINISHED tool in the open message means the step ends here — not a text phase', () => {
    // One assistant message is one step, and a tool call is what ends it. The
    // boundary a steer is read at is already arriving; ending the turn now
    // would throw away the continuation for nothing.
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'Checking.' }, tool('completed')])],
        TURN,
      ),
    ).toBe('other');
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'Checking.' }, tool('error')])],
        TURN,
      ),
    ).toBe('other');
  });

  test('a completed message, no assistant yet, and reasoning only are all "other"', () => {
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'All done.' }], 99)],
        TURN,
      ),
    ).toBe('other');
    expect(liveTurnPhaseFromPage([user(TURN)], TURN)).toBe('other');
    expect(
      liveTurnPhaseFromPage(
        [user(TURN), assistant('a1', TURN, [{ type: 'reasoning', text: 'thinking…', time: { start: 1 } }])],
        TURN,
      ),
    ).toBe('other');
  });

  test('the NEWEST step decides — an earlier finished step of the same turn does not', () => {
    expect(
      liveTurnPhaseFromPage(
        [
          user(TURN),
          assistant('a1', TURN, [{ type: 'text', text: 'Looking.' }, tool('completed')], 50),
          assistant('a2', TURN, [{ type: 'text', text: 'Here is what I found' }]),
        ],
        TURN,
      ),
    ).toBe('text');
    // …and a newest step that is already closed is never overruled by an
    // older one a crash left open.
    expect(
      liveTurnPhaseFromPage(
        [
          user(TURN),
          assistant('a1', TURN, [{ type: 'text', text: 'zombie' }]),
          assistant('a2', TURN, [{ type: 'text', text: 'final' }], 60),
        ],
        TURN,
      ),
    ).toBe('other');
  });

  test('assistant messages parented to a DIFFERENT user message are ignored', () => {
    expect(
      liveTurnPhaseFromPage(
        [user('msg_other'), assistant('a1', 'msg_other', [{ type: 'text', text: 'streaming…' }])],
        TURN,
      ),
    ).toBe('other');
    expect(
      liveTurnPhaseFromPage(
        [
          user(TURN),
          assistant('a1', TURN, [{ type: 'text', text: 'answer' }], 40),
          user('msg_steer'),
          assistant('a2', 'msg_steer', [{ type: 'text', text: 'streaming…' }]),
        ],
        TURN,
      ),
    ).toBe('other');
  });

  test('a malformed or empty payload is "other" — it can never end a response', () => {
    for (const payload of [null, undefined, 'nope', 42, {}, [], [null], [{}], [{ info: null, parts: 'x' }]]) {
      expect(liveTurnPhaseFromPage(payload, TURN)).toBe('other');
    }
    expect(
      liveTurnPhaseFromPage([{ info: { role: 'assistant', parentID: TURN }, parts: null }], TURN),
    ).toBe('other');
    expect(liveTurnPhaseFromPage([user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'x' }])], '')).toBe(
      'other',
    );
  });
});

describe('readLiveTurnPhase', () => {
  const active = { opencodeSessionId: 'ses_1', messageId: TURN };
  const endpoint = { url: 'https://box.test/proxy', headers: { Authorization: 'Bearer k' } };
  const textPage = [user(TURN), assistant('a1', TURN, [{ type: 'text', text: 'streaming' }])];

  test('reads the newest page of the root through the signed endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const resolved: Array<[string, string | null | undefined]> = [];
    const phase = await readLiveTurnPhase('sess-1', active, 'user-1', {
      resolveEndpoint: async (sessionId, actorUserId) => {
        resolved.push([sessionId, actorUserId]);
        return { endpoint, opencodeSessionId: 'ses_1' };
      },
      request: async (url, init) => {
        calls.push({ url, init });
        return Response.json(textPage);
      },
    });
    expect(phase).toBe('text');
    expect(resolved).toEqual([['sess-1', 'user-1']]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://box.test/proxy/session/ses_1/message?directory=%2Fworkspace&limit=${LIVE_TURN_PHASE_PAGE_LIMIT}`,
    );
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({ Authorization: 'Bearer k', 'Accept-Encoding': 'identity' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('FAILS OPEN to "other" — a read that did not happen never ends a response', async () => {
    const ok = async () => ({ endpoint, opencodeSessionId: 'ses_1' });
    // No endpoint.
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: async () => null,
        request: async () => {
          throw new Error('must not fetch');
        },
      }),
    ).toBe('other');
    // The session's root moved on: this is not the turn admission looked at.
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: async () => ({ endpoint, opencodeSessionId: 'ses_OTHER' }),
        request: async () => {
          throw new Error('must not fetch');
        },
      }),
    ).toBe('other');
    // Resolution throws, the fetch throws, the box answers 502, the body is HTML.
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: async () => {
          throw new Error('db down');
        },
        request: async () => Response.json(textPage),
      }),
    ).toBe('other');
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: ok,
        request: async () => {
          throw new Error('timeout');
        },
      }),
    ).toBe('other');
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: ok,
        request: async () => new Response('bad gateway', { status: 502 }),
      }),
    ).toBe('other');
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: ok,
        request: async () => new Response('<html>', { status: 200 }),
      }),
    ).toBe('other');
  });
  test('the bound covers the WHOLE read — a hung endpoint resolution, fetch, or body steers on time', async () => {
    // The 2.5s bound used to sit on the GET alone. Endpoint resolution (two
    // database reads plus proxy signing) ran unbounded while the row was
    // claimed, on the Enter key's critical path, and it repeats on every
    // admission attempt for the length of a streamed answer.
    const never = new Promise<never>(() => {});
    const ok = async () => ({ endpoint, opencodeSessionId: 'ses_1' });
    const startedAt = Date.now();

    expect(
      await readLiveTurnPhase('sess-1', active, null, { resolveEndpoint: () => never, timeoutMs: 25 }),
    ).toBe('other');

    let signal: AbortSignal | null | undefined;
    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: ok,
        request: (_url, init) => {
          signal = init.signal;
          return never;
        },
        timeoutMs: 25,
      }),
    ).toBe('other');
    // The abandoned GET is cancelled, not left open against the box.
    expect(signal?.aborted).toBe(true);

    expect(
      await readLiveTurnPhase('sess-1', active, null, {
        resolveEndpoint: ok,
        request: async () => ({ ok: true, json: () => never }) as unknown as Response,
        timeoutMs: 25,
      }),
    ).toBe('other');

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
