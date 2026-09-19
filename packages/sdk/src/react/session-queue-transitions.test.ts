import { afterEach, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import {
  applyInboxObservation,
  classifyPromptActionError,
  REMOVED_PROMPT_TOMBSTONE_MS,
  useSessionPrompts,
  type UseSessionPromptsResult,
} from './use-session-prompts';
import { useSessionWorking, type SessionTurnObservation } from './use-session-working';
import { projectWorking, type WorkingProjection } from '../core/session/working';
import type { RemovedSessionPrompt, SessionPrompt } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
let client: QueryClient;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  useSessionWorkingStore.getState().reset();
  globalThis.fetch = originalFetch;
});

function setup() {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useSessionWorkingStore.getState().reset();
}

test('Quick Queue remains visible while a pending poll is cancelled and POST waits', async () => {
  setup();
  const key = qk.project.sessionPrompts('p1', 's1');
  client.setQueryData(key, []);
  // Neither request resolves: the local acceptance state must not need either answer.
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  let queue: UseSessionPromptsResult;
  function Probe() { queue = useSessionPrompts('p1', 's1'); return null; }
  await act(async () => { root = create(createElement(QueryClientProvider, { client }, createElement(Probe))); });
  await act(async () => { void queue!.refetch(); });
  expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');
  await act(async () => {
    void queue!.enqueue({ placement: 'transcript', clientMessageId: 'c1', messageId: 'm1', parts: [{ type: 'text', text: 'first' }] });
    await Bun.sleep(10);
  });
  expect(queue!.prompts.map((prompt) => prompt.text)).toEqual(['first']);
});

test('the same turn changes from sending to running on its first active observation', async () => {
  setup();
  const key = qk.project.sessionTurn('p1', 's1');
  const atMs = Date.now();
  const observation: SessionTurnObservation = {
    atMs,
    turns: [{ turn_token: 't1', message_id: 'm1', opencode_session_id: 'wire1', state: 'delivering', started_at: new Date(atMs).toISOString(), accepted_at: new Date(atMs).toISOString() }],
  };
  client.setQueryData(key, observation);
  let working: WorkingProjection;
  function Probe() { working = useSessionWorking('p1', 's1'); return null; }
  await act(async () => { root = create(createElement(QueryClientProvider, { client }, createElement(Probe))); });
  expect(working!.pendingDelivery).toBe(true);
  await act(async () => {
    client.setQueryData(key, { ...observation, turns: observation.turns.map((turn) => ({ ...turn, state: 'active' })) });
    await Bun.sleep(10);
  });
  expect(working!.state).toBe('working');
  expect(working!.pendingDelivery).toBeUndefined();
});

test('a turn-end promotion whose delivering read was missed keeps the session working', () => {
  // Prompt B was POSTed while turn A ran, so the admission gate listed it
  // `waiting`. At A's end the drain claims B, delivers it, and the list drops
  // it. The 1 s poll missed the one-POST `delivering` window and saw `waiting`
  // go straight to absent. The cached `/turn` read predates the relay that
  // closes A, the wire idle frame ended A, and A's last content is old. Before
  // the fix, nothing armed the drain floor and the session read idle.
  useSessionWorkingStore.getState().reset();
  const iso = (ms: number) => new Date(ms).toISOString();
  const waiting: SessionPrompt = {
    placement: 'composer',
    prompt_id: 'pB',
    client_message_id: 'cB',
    message_id: 'W_B',
    wire_message_id: 'W_B',
    state: 'waiting',
    reason: 'turn_active',
    text: 'b',
    attempts: 0,
    last_error: null,
    created_at: iso(0),
    available_at: iso(0),
  };
  applyInboxObservation('s', undefined, [waiting], 2_010, 2_010);
  applyInboxObservation('s', [waiting], [], 3_010, 3_010);

  const inbox = useSessionWorkingStore.getState().inbox.s;
  expect(inbox?.drainedAtMs).toBe(3_010);

  const projection = projectWorking({
    optimistic: { messageId: 'W_B', turnId: 'A', atMs: -20_000, acceptedAtMs: -19_800 },
    inbox,
    server: {
      turns: [{ turn_token: 't_A', state: 'active', message_id: 'A', opencode_session_id: 'oc', started_at: iso(-60_000), accepted_at: null }],
      atMs: 1_010,
    },
    stream: { type: 'idle', origin: 'wire', atMs: 1_000 },
    activity: { atMs: -500 },
    nowMs: 3_050,
  });
  expect(projection).toMatchObject({ state: 'working', pendingDelivery: true, turnId: null });
});

// ── Row actions: one request, one outcome ───────────────────────────────────
// Remove and Retry sit side by side on a queue row, and the transcript bubble,
// take-back (Up / Edit) and the rewind loop all call `remove` on the same id.
// Each case drives the real hook against a scripted server.

const PROMPT_ID = '11111111-1111-4111-8111-111111111111';

function inboxRow(over: Partial<SessionPrompt> = {}): SessionPrompt {
  return {
    placement: 'composer',
    prompt_id: PROMPT_ID,
    client_message_id: 'c1',
    message_id: 'msg_aaaaaaaa',
    state: 'queued',
    reason: null,
    text: 'queued one',
    attempts: 0,
    last_error: null,
    created_at: '2026-09-17T10:00:00.000Z',
    available_at: '2026-09-17T10:00:00.000Z',
    ...over,
  };
}

const removedPrompt: RemovedSessionPrompt = {
  placement: 'composer',
  prompt_id: PROMPT_ID,
  client_message_id: 'c1',
  message_id: 'msg_aaaaaaaa',
  parts: [{ type: 'text', text: 'queued one' }],
  overrides: null,
  held: false,
};

type ServerReply = Response | Promise<Response>;

/**
 * A scripted server. Each handler answers one request; `list` answers GET
 * .../prompts. A list read with no scripted answer never settles, so a test
 * decides exactly which reads land.
 */
function scriptServer(handlers: {
  del?: (count: number) => ServerReply;
  retry?: (count: number) => ServerReply;
  list?: Array<() => Response>;
  /** Answers every GET the `list` script does not cover. */
  listAfter?: () => Response;
}) {
  const calls: { method: string; url: string }[] = [];
  const count = (method: string, suffix: string) =>
    calls.filter((call) => call.method === method && call.url.endsWith(suffix)).length;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'DELETE' && handlers.del) return handlers.del(count('DELETE', ''));
    if (method === 'POST' && url.endsWith('/retry') && handlers.retry) {
      return handlers.retry(count('POST', '/retry'));
    }
    if (method === 'GET') {
      const next = handlers.list?.shift() ?? handlers.listAfter;
      if (next) return next();
    }
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  return {
    calls,
    deletes: () => count('DELETE', ''),
    retries: () => count('POST', '/retry'),
  };
}

async function mountQueue(sessionId: string, rows: SessionPrompt[]) {
  const key = qk.project.sessionPrompts('p1', sessionId);
  client.setQueryData(key, rows);
  let queue: UseSessionPromptsResult;
  function Probe() {
    // A long cadence: only the reads a test asks for reach the scripted server.
    queue = useSessionPrompts('p1', sessionId, { pollMs: 600_000 });
    return null;
  }
  await act(async () => {
    root = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  return { key, queue: () => queue };
}

const listReply = (prompts: SessionPrompt[], observedAt: string) => () =>
  Response.json({ prompts, observed_at: observedAt });

test('two removes of one prompt in the same tick send one DELETE and share one result', async () => {
  // ✕ plus Edit on one row, or ✕ during the rewind loop, reach `remove` twice
  // before a re-render. The second DELETE used to 404 and paint a second,
  // contradictory toast.
  setup();
  const server = scriptServer({
    del: (count) =>
      count === 1
        ? Response.json({ removed: removedPrompt })
        : Response.json({ error: 'Not found', code: 'prompt_not_found' }, { status: 404 }),
    listAfter: listReply([], '2026-09-17T10:00:05.000Z'),
  });
  const { queue } = await mountQueue('s-remove-twice', [inboxRow()]);

  let first!: Promise<RemovedSessionPrompt>;
  let second!: Promise<RemovedSessionPrompt>;
  let settled: PromiseSettledResult<RemovedSessionPrompt>[] = [];
  await act(async () => {
    first = queue().remove(PROMPT_ID);
    second = queue().remove(PROMPT_ID);
    settled = await Promise.allSettled([first, second]);
  });

  expect(server.deletes()).toBe(1);
  expect(second).toBe(first);
  expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const [a, b] = settled as PromiseFulfilledResult<RemovedSessionPrompt>[];
  expect(a.value).toEqual(removedPrompt);
  expect(b.value).toBe(a.value);
});

test('a remove after this tab already removed the prompt sends nothing and returns that removal', async () => {
  // The instant session shell reads `removed.parts` from the result, so a
  // repeat call must resolve the removed prompt, never null.
  setup();
  const server = scriptServer({
    del: (count) =>
      count === 1
        ? Response.json({ removed: removedPrompt })
        : Response.json({ error: 'Not found', code: 'prompt_not_found' }, { status: 404 }),
    listAfter: listReply([], '2026-09-17T10:00:05.000Z'),
  });
  const { queue } = await mountQueue('s-remove-again', [inboxRow()]);

  let first: RemovedSessionPrompt | undefined;
  await act(async () => {
    first = await queue().remove(PROMPT_ID);
  });
  let again: unknown;
  await act(async () => {
    again = await queue()
      .remove(PROMPT_ID)
      .catch((error: unknown) => error);
  });

  expect(server.deletes()).toBe(1);
  expect(first).toEqual(removedPrompt);
  expect(again).toBe(first);
  expect(queue().pendingActions).toEqual({});
});

test('guard: a remove refused with 409 frees the row, so the next remove sends again', async () => {
  // Over-dedupe guard. `prompt_already_sent` means a step owns the row: the
  // tombstone is released so the next read lists it again, and a later remove
  // is a new intent that must reach the server.
  setup();
  const server = scriptServer({
    del: (count) =>
      count === 1
        ? Response.json(
            { error: 'Prompt is already being answered', code: 'prompt_already_sent' },
            { status: 409 },
          )
        : Response.json({ removed: removedPrompt }),
    list: [listReply([inboxRow({ state: 'delivering' })], '2026-09-17T10:00:05.000Z')],
    listAfter: listReply([], '2026-09-17T10:00:06.000Z'),
  });
  const { queue } = await mountQueue('s-remove-409', [inboxRow()]);

  let refusal: unknown;
  await act(async () => {
    refusal = await queue()
      .remove(PROMPT_ID)
      .catch((error: unknown) => error);
    await Bun.sleep(10);
  });
  expect(classifyPromptActionError(refusal)).toBe('already_sent');
  expect(queue().prompts.map((prompt) => prompt.state)).toEqual(['delivering']);

  let removed: RemovedSessionPrompt | undefined;
  await act(async () => {
    removed = await queue().remove(PROMPT_ID);
  });
  expect(server.deletes()).toBe(2);
  expect(removed).toEqual(removedPrompt);
});

test('guard: a remove refused as gone keeps the row off a read issued before the refusal', async () => {
  // `prompt_not_found` means someone else removed it. The tombstone stays, so
  // a read that left before the DELETE landed cannot list the row again.
  setup();
  scriptServer({
    del: () => Response.json({ error: 'Not found', code: 'prompt_not_found' }, { status: 404 }),
  });
  const { key, queue } = await mountQueue('s-remove-gone', [inboxRow()]);

  let refusal: unknown;
  await act(async () => {
    refusal = await queue()
      .remove(PROMPT_ID)
      .catch((error: unknown) => error);
  });
  expect(classifyPromptActionError(refusal)).toBe('gone');

  globalThis.fetch = (async () =>
    Response.json({ prompts: [inboxRow()], observed_at: '2026-09-17T10:00:05.000Z' })) as unknown as typeof fetch;
  await act(async () => {
    await queue().refetch();
    await Bun.sleep(10);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([]);
});

test('a remove settles on its DELETE; the list refetch after it does not hold the caller', async () => {
  // The "Removed from queue" toast is painted when `remove` resolves. It used
  // to wait for DELETE plus one whole GET .../prompts.
  setup();
  scriptServer({ del: () => Response.json({ removed: removedPrompt }) });
  const { queue } = await mountQueue('s-remove-fast', [inboxRow()]);

  let outcome: unknown;
  await act(async () => {
    outcome = await Promise.race([
      queue().remove(PROMPT_ID),
      Bun.sleep(200).then(() => 'still waiting for the list read'),
    ]);
  });
  expect(outcome).toEqual(removedPrompt);
});

test('retry twice then remove in one tick: one retry POST, no DELETE, and the remove is refused as pending', async () => {
  setup();
  let answerRetry!: (response: Response) => void;
  const server = scriptServer({
    retry: () => new Promise<Response>((resolve) => (answerRetry = resolve)),
    del: () => Response.json({ removed: removedPrompt }),
    listAfter: listReply([], '2026-09-17T10:00:11.000Z'),
  });
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  const { queue } = await mountQueue('s-retry-remove', [failed]);

  let first!: Promise<SessionPrompt>;
  let second!: Promise<SessionPrompt>;
  let refusal: unknown;
  await act(async () => {
    first = queue().retry(PROMPT_ID);
    second = queue().retry(PROMPT_ID);
    await queue()
      .remove(PROMPT_ID)
      .catch((error: unknown) => {
        refusal = error;
      });
    await Bun.sleep(10);
  });

  expect(server.retries()).toBe(1);
  expect(server.deletes()).toBe(0);
  expect(second).toBe(first);
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as { code?: string }).code).toBe('prompt_action_pending');
  expect(classifyPromptActionError(refusal)).toBe('pending');
  // No optimistic `queued`: the row must not turn removable while the drain
  // may be claiming it. The pending action carries that state instead.
  expect(queue().prompts).toEqual([failed]);
  expect(queue().pendingActions).toEqual({ [PROMPT_ID]: 'retry' });

  await act(async () => {
    answerRetry(
      Response.json({
        ...failed,
        state: 'queued',
        last_error: null,
        attempts: 0,
        observed_at: '2026-09-17T10:00:10.000Z',
      }),
    );
    await first;
    await Bun.sleep(10);
  });
  expect(queue().pendingActions).toEqual({});
});

test('a retried row shows the server row; an older failed read cannot repaint it, a newer one can', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  const requeued = inboxRow({ state: 'queued', last_error: null, attempts: 0 });
  const server = scriptServer({
    retry: () =>
      Response.json({ ...requeued, observed_at: '2026-09-17T10:00:10.000Z' }),
    list: [listReply([failed], '2026-09-17T10:00:09.000Z')],
  });
  const { key, queue } = await mountQueue('s-retry-order', [failed]);

  await act(async () => {
    await queue().retry(PROMPT_ID);
    await Bun.sleep(20);
  });
  // The refetch after the retry answered with a read the server took BEFORE
  // the retry wrote the row.
  expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([requeued]);

  const secondFailure = inboxRow({ state: 'failed', last_error: 'failed again', attempts: 1 });
  server.calls.length = 0;
  globalThis.fetch = (async () =>
    Response.json({
      prompts: [secondFailure],
      observed_at: '2026-09-17T10:00:11.000Z',
    })) as unknown as typeof fetch;
  await act(async () => {
    await queue().refetch();
    await Bun.sleep(10);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([secondFailure]);
  expect(queue().prompts).toEqual([secondFailure]);
});

test('a retry answered without a server stamp still keeps a failed read off the row for a while', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  const requeued = inboxRow({ state: 'queued', last_error: null, attempts: 0 });
  scriptServer({
    retry: () => Response.json(requeued),
    list: [listReply([failed], '2026-09-17T10:00:30.000Z')],
  });
  const { key, queue } = await mountQueue('s-retry-unstamped', [failed]);

  await act(async () => {
    await queue().retry(PROMPT_ID);
    await Bun.sleep(20);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([requeued]);
});

test('a retry refused with prompt_not_found drops the row at once and arms no drain', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  scriptServer({
    retry: () => Response.json({ error: 'Not found', code: 'prompt_not_found' }, { status: 404 }),
  });
  const { key, queue } = await mountQueue('s-retry-404', [failed]);

  let refusal: unknown;
  await act(async () => {
    void queue()
      .retry(PROMPT_ID)
      .catch((error: unknown) => {
        refusal = error;
      });
    await Bun.sleep(20);
  });
  // No list read has answered yet: the row left on the refusal itself.
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([]);
  expect(classifyPromptActionError(refusal)).toBe('gone');

  // A read issued before the refusal still lists the row. It stays gone.
  globalThis.fetch = (async () =>
    Response.json({ prompts: [failed], observed_at: '2026-09-17T10:00:19.000Z' })) as unknown as typeof fetch;
  await act(async () => {
    await queue().refetch();
    await Bun.sleep(10);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([]);
  expect(queue().prompts).toEqual([]);

  // The next read that omits the row is not a turn opening.
  globalThis.fetch = (async () =>
    Response.json({ prompts: [], observed_at: '2026-09-17T10:00:20.000Z' })) as unknown as typeof fetch;
  await act(async () => {
    await queue().refetch();
    await Bun.sleep(10);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([]);
  expect(queue().prompts).toEqual([]);
  expect(useSessionWorkingStore.getState().inbox['s-retry-404']?.drainedAtMs).toBeUndefined();
});

test('guard: a retry refused with a 500 leaves the failed row exactly as it was', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  scriptServer({
    retry: () => Response.json({ error: 'boom' }, { status: 500 }),
  });
  const { key, queue } = await mountQueue('s-retry-500', [failed]);

  await act(async () => {
    const retrying = queue()
      .retry(PROMPT_ID)
      .catch(() => undefined);
    await Promise.race([retrying, Bun.sleep(200)]);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([failed]);
});

const OTHER_PROMPT_ID = '22222222-2222-4222-8222-222222222222';

test('two hooks on one session share one lock per row and report the same pending action', async () => {
  // The session page and the chat both mount the hook. A Remove from one and
  // a Retry from the other on the same row must still be one intent.
  setup();
  let answerDelete!: (response: Response) => void;
  const server = scriptServer({
    del: () => new Promise<Response>((resolve) => (answerDelete = resolve)),
    retry: () =>
      Response.json(inboxRow({ prompt_id: OTHER_PROMPT_ID, client_message_id: 'c2' })),
    listAfter: listReply([], '2026-09-17T10:00:05.000Z'),
  });
  const sessionId = 's-two-hooks';
  client.setQueryData(qk.project.sessionPrompts('p1', sessionId), [
    inboxRow(),
    inboxRow({ prompt_id: OTHER_PROMPT_ID, client_message_id: 'c2', state: 'failed' }),
  ]);
  let list: UseSessionPromptsResult;
  let chat: UseSessionPromptsResult;
  let elsewhere: UseSessionPromptsResult;
  function List() {
    list = useSessionPrompts('p1', sessionId, { pollMs: 600_000 });
    return null;
  }
  function Chat() {
    chat = useSessionPrompts('p1', sessionId, { pollMs: 600_000 });
    return null;
  }
  function Elsewhere() {
    elsewhere = useSessionPrompts('p1', 's-two-hooks-other', { pollMs: 600_000 });
    return null;
  }
  await act(async () => {
    root = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(List),
        createElement(Chat),
        createElement(Elsewhere),
      ),
    );
  });

  let fromList!: Promise<RemovedSessionPrompt>;
  let fromChat!: Promise<RemovedSessionPrompt>;
  let refusal: unknown;
  await act(async () => {
    fromList = list!.remove(PROMPT_ID);
    fromChat = chat!.remove(PROMPT_ID);
    await chat!.retry(PROMPT_ID).catch((error: unknown) => {
      refusal = error;
    });
    // A different row is not locked by this one.
    await chat!.retry(OTHER_PROMPT_ID);
    await Bun.sleep(10);
  });

  expect(fromChat).toBe(fromList);
  expect(server.deletes()).toBe(1);
  expect(
    server.calls.filter((call) => call.method === 'POST').map((call) => call.url),
  ).toEqual([`http://test.local/projects/p1/sessions/${sessionId}/prompts/${OTHER_PROMPT_ID}/retry`]);
  expect((refusal as { code?: string }).code).toBe('prompt_action_pending');
  expect(list!.pendingActions).toEqual({ [PROMPT_ID]: 'remove' });
  expect(chat!.pendingActions).toEqual({ [PROMPT_ID]: 'remove' });
  expect(elsewhere!.pendingActions).toEqual({});

  await act(async () => {
    answerDelete(Response.json({ removed: removedPrompt }));
    await fromList;
    await Bun.sleep(10);
  });
  expect(await fromChat).toEqual(removedPrompt);
  expect(list!.pendingActions).toEqual({});
  expect(chat!.pendingActions).toEqual({});
});

test('a retry clears the hold on the cached rows, because the server released the session hold', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  const held = inboxRow({
    prompt_id: OTHER_PROMPT_ID,
    client_message_id: 'c2',
    message_id: 'msg_bbbbbbbb',
    state: 'waiting',
    reason: 'held',
  });
  const requeued = inboxRow({ state: 'queued', last_error: null, attempts: 0 });
  scriptServer({
    retry: () => Response.json({ ...requeued, observed_at: '2026-09-17T10:00:10.000Z' }),
  });
  const { key, queue } = await mountQueue('s-retry-hold', [failed, held]);

  await act(async () => {
    await queue().retry(PROMPT_ID);
  });
  expect(client.getQueryData<SessionPrompt[]>(key)).toEqual([requeued, { ...held, reason: null }]);
});

test('guard: a removal this tab made answers a repeat only inside the tombstone window', async () => {
  // Over-dedupe guard. Past the window a remove is a new intent and reaches
  // the server, which says the prompt is gone.
  setup();
  const server = scriptServer({
    del: (count) =>
      count === 1
        ? Response.json({ removed: removedPrompt })
        : Response.json({ error: 'Not found', code: 'prompt_not_found' }, { status: 404 }),
  });
  const { queue } = await mountQueue('s-remove-expired', [inboxRow()]);

  await act(async () => {
    await queue().remove(PROMPT_ID);
  });
  const later = Date.now() + REMOVED_PROMPT_TOMBSTONE_MS + 1;
  const clock = spyOn(Date, 'now').mockImplementation(() => later);
  let again: unknown;
  try {
    await act(async () => {
      again = await queue()
        .remove(PROMPT_ID)
        .catch((error: unknown) => error);
    });
  } finally {
    clock.mockRestore();
  }
  expect(server.deletes()).toBe(2);
  expect(classifyPromptActionError(again)).toBe('gone');
});

test('guard: a retry refused as already sent reads the queue again', async () => {
  setup();
  const failed = inboxRow({ state: 'failed', last_error: 'boom', attempts: 3 });
  const delivering = inboxRow({ state: 'delivering' });
  const server = scriptServer({
    retry: () =>
      Response.json(
        { error: 'Prompt was already sent', code: 'prompt_already_sent' },
        { status: 409 },
      ),
    list: [listReply([delivering], '2026-09-17T10:00:05.000Z')],
  });
  const { queue } = await mountQueue('s-retry-409', [failed]);

  let refusal: unknown;
  await act(async () => {
    refusal = await queue()
      .retry(PROMPT_ID)
      .catch((error: unknown) => error);
    await Bun.sleep(20);
  });
  expect(classifyPromptActionError(refusal)).toBe('already_sent');
  expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  expect(queue().prompts).toEqual([delivering]);
});
