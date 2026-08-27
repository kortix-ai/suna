import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { configureKortix } from '../core/http/config';
import { INBOX_OBSERVATION_MAX_MS } from '../core/session/working';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import type { SessionPrompt } from '../core/rest/projects-client/sessions';
import {
  applyOptimisticPrompt,
  optimisticSessionPrompt,
  reconcileOptimisticPrompts,
  removeOptimisticPrompt,
  settleOptimisticPrompt,
  SESSION_PROMPTS_IDLE_POLL_MS,
  SESSION_PROMPTS_POLL_MS,
  noteInboxObservation,
  promptsRefetchInterval,
  readSessionPromptsInbox,
  sessionPromptsPollMs,
  startSessionWithPrompt,
} from './use-session-prompts';

/**
 * The polling cadence is a CORRECTNESS decision, not a performance one.
 *
 * A prompt can ENTER this list without the tab doing anything: the reaper
 * redelivers one whose turn never ran, and parking a box requeues its in-flight
 * prompt as `held`. Both land on a session whose list is, at that moment, empty
 * — and the `held` design depends on the user seeing the row so they can
 * release it. A cadence of `false` at zero rows means the tab never learns, and
 * only a full page load recovers.
 */
describe('sessionPromptsPollMs', () => {
  test('polls fast while prompts are pending — their state changes on its own', () => {
    expect(sessionPromptsPollMs(1)).toBe(SESSION_PROMPTS_POLL_MS);
    expect(sessionPromptsPollMs(7)).toBe(SESSION_PROMPTS_POLL_MS);
  });

  test('an EMPTY list still polls, slowly — a prompt can come back on its own', () => {
    expect(sessionPromptsPollMs(0)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
    expect(SESSION_PROMPTS_IDLE_POLL_MS).toBeGreaterThan(SESSION_PROMPTS_POLL_MS);
  });

  test('an explicit cadence overrides the busy one, never the idle one', () => {
    // Hosts tune the busy cadence for their own UI. The idle floor is not
    // theirs to remove: it is what makes a re-entering prompt visible.
    expect(sessionPromptsPollMs(2, 500)).toBe(500);
    expect(sessionPromptsPollMs(0, 500)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });

  /**
   * The cadence is picked from the PREVIOUS result, and that is what opened the
   * hole this covers.
   *
   * `notePromptAccepted` records a believed pending row the instant
   * `POST .../prompts` returns, because `GET .../turn` cannot see the send yet
   * and the composer must not swap Stop back to Send underneath it. That belief
   * is an OBSERVATION like any other, so `projectWorking` expires it at
   * `INBOX_OBSERVATION_MAX_MS` (10s) — and only a list read can refresh it.
   *
   * MEASURED on the local stack 2026-08-21: a first read landed before the row
   * existed, answered zero, and locked the cadence to `SESSION_PROMPTS_IDLE_POLL_MS`
   * (15s). Nothing then refreshed the belief inside its 10s life, and the
   * projection dropped to `idle` at 23:44:18.284 with `inbox=1@10004` while the
   * user's prompt was still pending — a guaranteed 5s hole between the two
   * constants, in which the composer offers Send for a prompt already queued.
   *
   * The list length alone cannot close it, because at that moment the list is
   * honestly empty. What the tab BELIEVES is pending has to count too.
   */
  test('a believed pending row polls fast even when the fetched list is empty', () => {
    expect(sessionPromptsPollMs(0, undefined, 1)).toBe(SESSION_PROMPTS_POLL_MS);
  });

  test('the cadence that refreshes the belief must outlive nothing — it must beat the bound', () => {
    // The invariant behind the test above, stated so a future change to either
    // constant cannot silently reopen the hole.
    expect(sessionPromptsPollMs(0, undefined, 1)).toBeLessThan(INBOX_OBSERVATION_MAX_MS);
    expect(sessionPromptsPollMs(1)).toBeLessThan(INBOX_OBSERVATION_MAX_MS);
  });

  test('no belief and no rows still means the idle floor', () => {
    expect(sessionPromptsPollMs(0, undefined, 0)).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });
});

/**
 * The inbox is a WORKING signal, not just a list to render.
 *
 * A prompt is durably accepted long before it is a turn — the row still has to
 * be drained and the box may still have to resume. `GET .../turn` answers "no
 * turns" for all of it, honestly, and the composer used to believe that and
 * swap Stop back to Send while the user's prompt sat in the queue. Every read
 * of the list therefore feeds `projectWorking` too.
 */
describe('noteInboxObservation', () => {
  const prompt = (over: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T10:00:00.000Z',
    available_at: '2026-08-18T10:00:00.000Z',
    ...over,
  });

  test('records how many rows the server still intends to run, and when it looked', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt(), prompt({ prompt_id: 'p2', state: 'delivering' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 2, atMs: 500 });
  });

  test('a held queue records zero — Stop must put the composer back', () => {
    useSessionWorkingStore.getState().reset();
    noteInboxObservation('sess_1', [prompt({ state: 'waiting', reason: 'held' })], 500);

    expect(useSessionWorkingStore.getState().inbox.sess_1).toEqual({ pending: 0, atMs: 500 });
  });

});

/**
 * The first prompt of a brand-new session, as ONE durable POST — the SDK
 * function every "new session" producer calls instead of stashing the text in
 * sessionStorage for a replay effect to send 19-25s later (the measured boot),
 * during which a closed tab lost the message silently.
 */
describe('startSessionWithPrompt', () => {
  test('POSTs the prompt with a minted wire id and files the receipt around the round-trip', async () => {
    useSessionWorkingStore.getState().reset();
    const calls: any[] = [];
    const result = await startSessionWithPrompt(
      'proj-1',
      'sess-1',
      { parts: [{ type: 'text', text: 'go' }], overrides: { agent: 'default' } },
      {
        create: async (projectId, sessionId, input) => {
          // The receipt is taken BEFORE the POST: from here a `/turn` read is
          // barred from answering idle until the row is durable or refused.
          expect(useSessionWorkingStore.getState().receipts['sess-1']).not.toBeNull();
          calls.push([projectId, sessionId, input]);
          return { prompt_id: 'p1', state: 'queued', message_id: input.messageId, deduped: false };
        },
      },
    );

    expect(result.state).toBe('queued');
    expect(calls).toHaveLength(1);
    const [projectId, sessionId, input] = calls[0];
    expect(projectId).toBe('proj-1');
    expect(sessionId).toBe('sess-1');
    expect(input.messageId).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(input.clientMessageId.length).toBeGreaterThan(8);
    // This producer can never read a transcript, so it must say so.
    expect(input.remintOnDelivery).toBe(true);
    expect(input.parts).toEqual([{ type: 'text', text: 'go' }]);
    expect(input.overrides).toEqual({ agent: 'default' });
    // Accepted: the server has the row, and the projection may answer for it.
    const receipt = useSessionWorkingStore.getState().receipts['sess-1'];
    expect(receipt?.acceptedAtMs ?? null).not.toBeNull();
  });

  test('a refused row drops the receipt and throws instead of posing as sent', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-2',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async (_p, _s, input) => ({
            prompt_id: 'p1',
            state: 'failed',
            message_id: input.messageId,
            deduped: true,
          }),
        },
      ),
    ).rejects.toThrow(/refused/i);
    expect(useSessionWorkingStore.getState().receipts['sess-2']).toBeFalsy();
  });

  test('a network failure also drops the receipt', async () => {
    useSessionWorkingStore.getState().reset();
    await expect(
      startSessionWithPrompt(
        'proj-1',
        'sess-3',
        { parts: [{ type: 'text', text: 'go' }] },
        {
          create: async () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
    expect(useSessionWorkingStore.getState().receipts['sess-3']).toBeFalsy();
  });
});

/**
 * Enter must paint the queue row IMMEDIATELY. The row is durable only once
 * `POST .../prompts` returns, but the user pressed Enter now: the strip shows
 * an optimistic row (`prompt_id` = `optimistic:<clientMessageId>`, state
 * `queued`) in the same frame, and the server's row replaces it on the
 * response — or it disappears on failure so a refused send never lingers.
 */
describe('optimistic queue rows', () => {
  const input = {
    clientMessageId: 'c1',
    messageId: 'msg_0168552a2001AAAAAAAAAAAAAA',
    parts: [{ type: 'text' as const, text: 'hello there' }, { type: 'file' as const, url: 'x', mime: 'image/png', filename: 'a.png' }],
  };

  test("optimisticSessionPrompt renders the text of the parts, in the strip's shape", () => {
    const row = optimisticSessionPrompt(input, 1_000);
    expect(row.prompt_id).toBe('optimistic:c1');
    expect(row.client_message_id).toBe('c1');
    expect(row.message_id).toBe(input.messageId);
    expect(row.state).toBe('queued');
    expect(row.text).toBe('hello there');
    expect(row.attempts).toBe(0);
    expect(row.created_at).toBe(new Date(1_000).toISOString());
  });

  test('applyOptimisticPrompt appends once and is idempotent for the same submission', () => {
    const a = applyOptimisticPrompt([], input, 1_000);
    const b = applyOptimisticPrompt(a, input, 2_000);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0].prompt_id).toBe('optimistic:c1');
  });

  test('settleOptimisticPrompt swaps the optimistic row for the server row by client id', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const settled = settleOptimisticPrompt(rows, 'c1', {
      prompt_id: 'p-real',
      state: 'delivering',
      message_id: input.messageId,
      deduped: false,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0].prompt_id).toBe('p-real');
    expect(settled[0].state).toBe('delivering');
    expect(settled[0].text).toBe('hello there');
  });

  test('a failed submission removes the optimistic row', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    expect(removeOptimisticPrompt(rows, 'c1')).toEqual([]);
  });

  test('a real row that already carries the client id wins over a stale optimistic one', () => {
    // The poll can land the server's row before the mutation settles.
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, [
      { prompt_id: 'p-real', client_message_id: 'c1', message_id: input.messageId, state: 'queued', reason: null, text: 'hello there', attempts: 0, last_error: null, created_at: 'x', available_at: 'x' },
    ]);
    expect(merged.map((r) => r.prompt_id)).toEqual(['p-real']);
  });

  test('reconcile keeps optimistic rows the server has not listed yet (POST still in flight)', () => {
    const rows = applyOptimisticPrompt([], input, 1_000);
    const merged = reconcileOptimisticPrompts(rows, []);
    expect(merged.map((r) => r.prompt_id)).toEqual(['optimistic:c1']);
  });
});

/**
 * The inbox is PROJECT-scoped, and not every session has a project.
 *
 * A sub-session — the "Agent · general: …" panel `SubSessionModal` opens over
 * the transcript — is a local OpenCode child. It is rendered by `SessionChat`
 * with a `sessionId` and NOTHING else: no project id, no project session id.
 * The `enabled` flag on the query covers react-query's own scheduling, but it
 * is not the only way into the request: `QueryObserver.refetch()` goes
 * straight to `query.fetch()` with no `enabled` check, and `session-chat.tsx`
 * calls `promptInbox.refetch()` the moment a new user bubble lands — which is
 * exactly what a streaming sub-agent produces.
 *
 * The two `undefined`s then went into `listSessionPrompts`'s template literal
 * and came out as text: `GET /projects/undefined/sessions/undefined/prompts`
 * → 400 `Invalid session id` → a red toast beside a sub-agent that was
 * rendering perfectly. The read itself has to refuse, so no path can build
 * that URL.
 */
describe('readSessionPromptsInbox', () => {
  const stubFetch = () => {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return Response.json({ prompts: [] });
    }) as unknown as typeof fetch;
    return { urls, restore: () => void (globalThis.fetch = original) };
  };

  test('a session with no project issues NO request', async () => {
    const stub = stubFetch();
    try {
      expect(await readSessionPromptsInbox(undefined, undefined, undefined)).toEqual([]);
      expect(await readSessionPromptsInbox(undefined, 'sess-1', undefined)).toEqual([]);
      expect(await readSessionPromptsInbox('proj-1', undefined, undefined)).toEqual([]);
      expect(stub.urls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test('a session with no project keeps the rows already on screen', async () => {
    const stub = stubFetch();
    const cached = applyOptimisticPrompt(
      [],
      { clientMessageId: 'c1', messageId: 'msg_01', parts: [{ type: 'text', text: 'hi' }] },
      1_000,
    );
    try {
      expect(await readSessionPromptsInbox(undefined, undefined, cached)).toEqual(cached);
      expect(stub.urls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test('a project session still reads its own inbox', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetch();
    try {
      expect(await readSessionPromptsInbox('proj-1', 'sess-1', undefined)).toEqual([]);
      expect(stub.urls).toEqual(['http://api.test/v1/projects/proj-1/sessions/sess-1/prompts']);
    } finally {
      stub.restore();
      configureKortix({ backendUrl: '', getToken: async () => null });
    }
  });
});

// ── The session-open bundle seam ────────────────────────────────────────────

describe('readSessionPromptsInbox and the open bundle', () => {
  beforeEach(() => {
    // An earlier case deliberately misconfigures the client to prove the
    // unconfigured path; re-arm here rather than depend on file order.
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
  });

  function mockFetch(body: (url: string) => unknown) {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body(String(url))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return urls;
  }

  function bundle(queue: unknown) {
    return {
      observed_at: '2026-08-26T12:00:00.000Z',
      session: { session_id: 'S1' },
      turn: { known: true, turns: [] },
      queue,
      transcript: { known: true, requested: false },
      config: { known: true },
      models: { known: false, reason: 'llm_gateway_disabled' },
    };
  }

  test('answers from the open bundle without touching /prompts', async () => {
    resetSessionOpenBundles();
    const row = { prompt_id: 'p1', state: 'queued', text: 'hi' };
    const urls = mockFetch(() => bundle({ known: true, prompts: [row], held: false }));
    openSessionBundle('P1', 'S1');
    const prompts = await readSessionPromptsInbox('P1', 'S1', undefined);
    expect(urls.filter((u) => u.endsWith('/prompts'))).toHaveLength(0);
    expect(prompts).toEqual([row] as never);
  });

  test('the bundled rows still feed the working projection', async () => {
    resetSessionOpenBundles();
    useSessionWorkingStore.getState().clearSession('S1');
    mockFetch(() =>
      bundle({ known: true, prompts: [{ prompt_id: 'p1', state: 'queued' }], held: false }),
    );
    openSessionBundle('P1', 'S1');
    await readSessionPromptsInbox('P1', 'S1', undefined);
    // The inbox observation is what keeps the composer showing Stop while a
    // prompt is durable but not yet a turn. Serving the list from the bundle
    // must not skip it.
    expect(useSessionWorkingStore.getState().inbox.S1?.pending).toBe(1);
  });

  test('falls back to /prompts when the bundle could not read the inbox', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch((url) =>
      url.includes('snapshot')
        ? bundle({ known: false, reason: 'inbox read failed' })
        : { prompts: [{ prompt_id: 'p9', state: 'queued' }] },
    );
    openSessionBundle('P1', 'S1');
    const prompts = await readSessionPromptsInbox('P1', 'S1', undefined);
    expect(urls.some((u) => u.endsWith('/prompts'))).toBe(true);
    expect(prompts[0]?.prompt_id).toBe('p9');
  });
});

describe('promptsRefetchInterval (stream presence hands the cadence over)', () => {
  test('poll owner with no stream keeps the two-cadence contract', () => {
    expect(
      promptsRefetchInterval({ pollOwner: true, streamConnected: false, count: 2, believedPending: 0 }),
    ).toBe(SESSION_PROMPTS_POLL_MS);
    expect(
      promptsRefetchInterval({ pollOwner: true, streamConnected: false, count: 0, believedPending: 0 }),
    ).toBe(SESSION_PROMPTS_IDLE_POLL_MS);
  });

  test('a connected stream silences the poll — kortix.control.queue is the same list', () => {
    expect(
      promptsRefetchInterval({ pollOwner: true, streamConnected: true, count: 2, believedPending: 1 }),
    ).toBe(false);
  });

  test('a non-owner never polls', () => {
    expect(
      promptsRefetchInterval({ pollOwner: false, streamConnected: false, count: 5, believedPending: 0 }),
    ).toBe(false);
  });
});
