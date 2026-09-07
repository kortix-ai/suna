import { describe, expect, test } from 'bun:test';

import {
  DurableSessionStorage,
  MAX_SESSION_LOG_ITEM_BYTES,
  RemoteSessionLog,
  SessionLogConflictError,
  SessionLogItemTooLargeError,
  SessionLogUnavailableError,
} from './session-store.ts';

const APPEND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function response(status: number): Response {
  return new Response(status === 204 ? null : 'failure', { status });
}

describe('RemoteSessionLog', () => {
  test('rejects an oversized item locally without poisoning later writes', async () => {
    let calls = 0;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        fetch: async () => {
          calls += 1;
          return response(204);
        },
      },
    );

    expect(() =>
      log.preflight({ kind: 'name', name: 'x'.repeat(MAX_SESSION_LOG_ITEM_BYTES) }),
    ).toThrow(SessionLogItemTooLargeError);
    expect(calls).toBe(0);
    expect(log.error).toBeNull();

    await log.append({ kind: 'name', name: 'small' });
    expect(calls).toBe(1);
  });

  test('poisons the log when a post-admission item is too large to persist', async () => {
    let calls = 0;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        fetch: async () => {
          calls += 1;
          return response(204);
        },
      },
    );

    await expect(
      log.append({ kind: 'name', name: 'x'.repeat(MAX_SESSION_LOG_ITEM_BYTES) }),
    ).rejects.toBeInstanceOf(SessionLogUnavailableError);
    expect(calls).toBe(0);
    expect(log.error?.message).toContain('maximum is 524288');
    await expect(log.append({ kind: 'name', name: 'small' })).rejects.toBeInstanceOf(
      SessionLogUnavailableError,
    );
  });

  test('retries a lost append response with the same idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let committed = 0;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        fetch: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          if (calls.length === 1) {
            committed += 1;
            throw new TypeError('socket closed after commit');
          }
          return response(204);
        },
        sleep: async () => {},
      },
    );

    await log.append({ kind: 'name', name: 'durable' });

    expect(committed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(APPEND_ID);
    expect(new Headers(calls[1]!.init.headers).get('idempotency-key')).toBe(APPEND_ID);
    expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
  });

  test('surfaces an idempotency fence conflict without poisoning unrelated writes', async () => {
    let status = 409;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      { createAppendId: () => APPEND_ID, fetch: async () => response(status) },
    );

    await expect(log.append({ kind: 'name', name: 'lost fence' })).rejects.toBeInstanceOf(
      SessionLogConflictError,
    );
    expect(log.error).toBeNull();
    status = 204;
    await expect(log.append({ kind: 'name', name: 'next item' })).resolves.toBeUndefined();
  });

  test('reconciles a committed append after every response is lost', async () => {
    const stored: unknown[] = [];
    let postCalls = 0;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        maxAttempts: 2,
        fetch: async (_url, init) => {
          if (init?.method === 'POST') {
            postCalls += 1;
            if (stored.length === 0) stored.push(JSON.parse(String(init.body)));
            throw new TypeError('socket closed after commit');
          }
          return Response.json(stored);
        },
        sleep: async () => {},
      },
    );

    await log.append({ kind: 'name', name: 'durable' });

    expect(postCalls).toBe(2);
    expect(stored).toEqual([{ kind: 'name', name: 'durable', _kortixAppendId: APPEND_ID }]);
    expect(() => log.assertWritable()).not.toThrow();
  });

  test('reconciles committed JSON-canonical content after every response is lost', async () => {
    const stored: unknown[] = [];
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        maxAttempts: 2,
        fetch: async (_url, init) => {
          if (init?.method === 'POST') {
            if (stored.length === 0) stored.push(JSON.parse(String(init.body)));
            throw new TypeError('socket closed after commit');
          }
          return Response.json(stored);
        },
        sleep: async () => {},
      },
    );

    await expect(log.append({ kind: 'name', name: undefined })).resolves.toBeUndefined();

    expect(stored).toEqual([{ kind: 'name', _kortixAppendId: APPEND_ID }]);
    expect(log.error).toBeNull();
  });

  test('surfaces a reconciled same-key conflict without poisoning later writes', async () => {
    let winnerVisible = true;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        maxAttempts: 1,
        fetch: async (_url, init) => {
          if (init?.method === 'POST') {
            if (!winnerVisible) return response(204);
            throw new TypeError('socket closed before the response');
          }
          return Response.json([
            { kind: 'name', name: 'winning content', _kortixAppendId: APPEND_ID },
          ]);
        },
      },
    );

    await expect(log.append({ kind: 'name', name: 'losing content' })).rejects.toBeInstanceOf(
      SessionLogConflictError,
    );
    expect(log.error).toBeNull();

    winnerVisible = false;
    await expect(log.append({ kind: 'name', name: 'later content' })).resolves.toBeUndefined();
  });

  test('poisons the log when reconciliation returns a malformed snapshot', async () => {
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        maxAttempts: 1,
        fetch: async (_url, init) => {
          if (init?.method === 'POST') throw new TypeError('socket closed before the response');
          return Response.json({ items: [] });
        },
      },
    );

    await expect(log.append({ kind: 'name', name: 'unknown outcome' })).rejects.toBeInstanceOf(
      SessionLogUnavailableError,
    );
    expect(log.error).toBeInstanceOf(SessionLogUnavailableError);
  });

  test('poisons future writes when a failed append is absent from the remote log', async () => {
    let postCalls = 0;
    const log = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        maxAttempts: 2,
        fetch: async (_url, init) => {
          if (init?.method === 'POST') {
            postCalls += 1;
            throw new TypeError('store unavailable');
          }
          return Response.json([]);
        },
        sleep: async () => {},
      },
    );

    await expect(log.append({ kind: 'name', name: 'missing' })).rejects.toBeInstanceOf(
      SessionLogUnavailableError,
    );
    expect(postCalls).toBe(2);
    expect(() => log.assertWritable()).toThrow(SessionLogUnavailableError);
    await expect(log.append({ kind: 'name', name: 'blocked' })).rejects.toBeInstanceOf(
      SessionLogUnavailableError,
    );
    expect(postCalls).toBe(2);
  });

  test('retries transient HTTP failures but does not retry a permanent 4xx', async () => {
    const transientStatuses = [503, 204];
    let transientCalls = 0;
    const transient = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        fetch: async () => response(transientStatuses[transientCalls++]!),
        sleep: async () => {},
      },
    );
    await transient.append({ kind: 'name', name: 'durable' });
    expect(transientCalls).toBe(2);

    let permanentCalls = 0;
    const permanent = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        createAppendId: () => APPEND_ID,
        fetch: async () => {
          permanentCalls += 1;
          return response(403);
        },
        sleep: async () => {},
      },
    );
    await expect(permanent.append({ kind: 'name', name: 'blocked' })).rejects.toThrow(
      'session log append failed: HTTP 403',
    );
    expect(permanentCalls).toBe(1);
  });

  test('retries a transient replay read and stops on a permanent read failure', async () => {
    const transientStatuses = [503, 200];
    let transientCalls = 0;
    const transient = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        fetch: async () => {
          const status = transientStatuses[transientCalls++]!;
          return status === 200
            ? Response.json([{ kind: 'name', name: 'restored' }])
            : response(status);
        },
        sleep: async () => {},
      },
    );
    expect(await transient.read()).toEqual([{ kind: 'name', name: 'restored' }]);
    expect(transientCalls).toBe(2);

    let permanentCalls = 0;
    const permanent = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        fetch: async () => {
          permanentCalls += 1;
          return response(401);
        },
        sleep: async () => {},
      },
    );
    await expect(permanent.read()).rejects.toThrow('session log read failed: HTTP 401');
    expect(permanentCalls).toBe(1);
  });

  test('accepts an explicit empty log but rejects a missing session log', async () => {
    const empty = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'session-1',
      {},
      {
        fetch: async () => Response.json([]),
      },
    );
    expect(await empty.read()).toEqual([]);

    let missingCalls = 0;
    const missing = new RemoteSessionLog(
      'https://api.example.test/projects/p',
      'missing',
      {},
      {
        fetch: async () => {
          missingCalls += 1;
          return response(404);
        },
        sleep: async () => {},
      },
    );
    await expect(missing.read()).rejects.toThrow('session log read failed: HTTP 404');
    expect(missingCalls).toBe(1);
  });
});

describe('DurableSessionStorage', () => {
  test('ignores journal records while replaying the Pi session tree', async () => {
    const appended: unknown[] = [];
    const { storage, restoredEntries } = await DurableSessionStorage.open(
      { id: 'session-1', createdAt: 1 },
      {
        append: async (item) => {
          appended.push(item);
        },
        read: async () => [
          {
            kind: 'journal',
            stream: 'kortix.pi.turn-admission.v1',
            record: { type: 'accepted', turn: { messageId: 'msg_01' } },
          },
          { kind: 'name', name: 'restored' },
        ],
      },
    );

    expect(restoredEntries).toBe(0);
    expect(await storage.getName()).toBe('restored');
    expect(appended).toEqual([]);
  });
});
