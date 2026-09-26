// Expo client with an injected fetch and an in-memory token store (DI, no
// mock.module): batching, the single retry, ticket parsing, and the
// DeviceNotRegistered cleanup.
import { describe, expect, test } from 'bun:test';
import { EXPO_PUSH_URL, sendExpoPushMessages, type ExpoPushMessage, type ExpoPushTicket } from './expo-push';

function message(i: number): ExpoPushMessage {
  return {
    to: `ExponentPushToken[synthetic-${i}]`,
    title: 'Kortix',
    body: 'Session complete. Tap to see the result.',
    data: { type: 'completion', projectId: 'p', sessionId: 's' },
    sound: 'kortix_complete.wav',
    channelId: 'session-complete',
    priority: 'high',
  };
}

// Collects the client's warnings so failure paths stay quiet in test output.
const warnings: unknown[][] = [];
const logger = { warn: (...args: unknown[]) => void warnings.push(args) };

type Call = { url: string; init: RequestInit; body: ExpoPushMessage[] };

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url, init, body: JSON.parse(String(init.body)) as ExpoPushMessage[] };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const okTickets = (call: Call) =>
  Response.json({ data: call.body.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })) });

function memoryStore() {
  const deleted: string[][] = [];
  return {
    deleted,
    store: {
      async deleteTokens(tokens: readonly string[]) {
        deleted.push([...tokens]);
        return tokens.length;
      },
    },
  };
}

describe('sendExpoPushMessages', () => {
  test('posts JSON to the Expo push endpoint', async () => {
    const { fn, calls } = fakeFetch(okTickets);
    const result = await sendExpoPushMessages([message(1)], { fetch: fn, retryDelayMs: 0, logger });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPO_PUSH_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toEqual([message(1)]);
    expect(result.tickets).toEqual([{ token: message(1).to, ticket: { status: 'ok', id: 'ticket-0' } }]);
    expect(result.failedMessages).toBe(0);
  });

  test('EXPO_ACCESS_TOKEN adds a bearer header', async () => {
    const { fn, calls } = fakeFetch(okTickets);
    await sendExpoPushMessages([message(1)], { fetch: fn, accessToken: 'synthetic-access', retryDelayMs: 0, logger });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer synthetic-access');
  });

  test('splits 250 messages into batches of 100, 100, 50', async () => {
    const { fn, calls } = fakeFetch(okTickets);
    const messages = Array.from({ length: 250 }, (_, i) => message(i));
    const result = await sendExpoPushMessages(messages, { fetch: fn, retryDelayMs: 0, logger });

    expect(calls.map((c) => c.body.length)).toEqual([100, 100, 50]);
    expect(calls.flatMap((c) => c.body.map((m) => m.to))).toEqual(messages.map((m) => m.to));
    expect(result.tickets).toHaveLength(250);
  });

  test('exactly 100 messages is one request', async () => {
    const { fn, calls } = fakeFetch(okTickets);
    await sendExpoPushMessages(
      Array.from({ length: 100 }, (_, i) => message(i)),
      { fetch: fn, retryDelayMs: 0, logger },
    );
    expect(calls).toHaveLength(1);
  });

  test('retries once after a 5xx and succeeds', async () => {
    const { fn, calls } = fakeFetch((call, i) => (i === 0 ? new Response('busy', { status: 503 }) : okTickets(call)));
    const result = await sendExpoPushMessages([message(1)], { fetch: fn, retryDelayMs: 0, logger });
    expect(calls).toHaveLength(2);
    expect(result.tickets).toHaveLength(1);
    expect(result.failedMessages).toBe(0);
  });

  test('retries once after a network error and succeeds', async () => {
    const { fn, calls } = fakeFetch((call, i) => {
      if (i === 0) throw new TypeError('fetch failed');
      return okTickets(call);
    });
    const result = await sendExpoPushMessages([message(1)], { fetch: fn, retryDelayMs: 0, logger });
    expect(calls).toHaveLength(2);
    expect(result.tickets).toHaveLength(1);
  });

  test('gives up after the one retry and never throws', async () => {
    const { fn, calls } = fakeFetch(() => new Response('down', { status: 502 }));
    const result = await sendExpoPushMessages([message(1), message(2)], { fetch: fn, retryDelayMs: 0, logger });
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ tickets: [], removedTokens: [], failedMessages: 2 });
    expect(warnings.at(-1)).toEqual(['[push] expo batch failed', { size: 2, reason: 'HTTP 502' }]);
  });

  test('a 4xx is not retried', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({ errors: [{ code: 'VALIDATION_ERROR' }] }, { status: 400 }));
    const result = await sendExpoPushMessages([message(1)], { fetch: fn, retryDelayMs: 0, logger });
    expect(calls).toHaveLength(1);
    expect(result.failedMessages).toBe(1);
  });

  test('a failed batch does not stop the next batch', async () => {
    const { fn, calls } = fakeFetch((call, i) => (i < 2 ? new Response('', { status: 500 }) : okTickets(call)));
    const result = await sendExpoPushMessages(
      Array.from({ length: 150 }, (_, i) => message(i)),
      { fetch: fn, retryDelayMs: 0, logger },
    );
    expect(calls.map((c) => c.body.length)).toEqual([100, 100, 50]);
    expect(result.failedMessages).toBe(100);
    expect(result.tickets).toHaveLength(50);
  });

  test('deletes exactly the tokens whose ticket says DeviceNotRegistered', async () => {
    const tickets: ExpoPushTicket[] = [
      { status: 'ok', id: 'a' },
      { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
    ];
    const { fn } = fakeFetch(() => Response.json({ data: tickets }));
    const { store, deleted } = memoryStore();
    const result = await sendExpoPushMessages([message(1), message(2), message(3)], {
      fetch: fn,
      store,
      retryDelayMs: 0, logger,
    });
    expect(deleted).toEqual([[message(2).to]]);
    expect(result.removedTokens).toEqual([message(2).to]);
  });

  test('no DeviceNotRegistered ticket, no delete', async () => {
    const { fn } = fakeFetch(okTickets);
    const { store, deleted } = memoryStore();
    await sendExpoPushMessages([message(1)], { fetch: fn, store, retryDelayMs: 0, logger });
    expect(deleted).toEqual([]);
  });

  test('a store failure during cleanup does not throw', async () => {
    const { fn } = fakeFetch(() =>
      Response.json({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
    );
    const store = {
      async deleteTokens(): Promise<number> {
        throw new Error('db down');
      },
    };
    const result = await sendExpoPushMessages([message(1)], { fetch: fn, store, retryDelayMs: 0, logger });
    expect(result.removedTokens).toEqual([]);
  });

  test('an empty message list sends nothing', async () => {
    const { fn, calls } = fakeFetch(okTickets);
    await sendExpoPushMessages([], { fetch: fn, retryDelayMs: 0, logger });
    expect(calls).toHaveLength(0);
  });
});
