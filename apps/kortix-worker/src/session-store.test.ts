import { describe, expect, test } from 'bun:test';

import { RemoteSessionLog } from './session-store.ts';

const APPEND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function response(status: number): Response {
  return new Response(status === 204 ? null : 'failure', { status });
}

describe('RemoteSessionLog', () => {
  test('retries a lost append response with the same idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let committed = 0;
    const log = new RemoteSessionLog('https://api.example.test/projects/p', 'session-1', {}, {
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
    });

    await log.append({ kind: 'name', name: 'durable' });

    expect(committed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(APPEND_ID);
    expect(new Headers(calls[1]!.init.headers).get('idempotency-key')).toBe(APPEND_ID);
    expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
  });

  test('retries transient HTTP failures but does not retry a permanent 4xx', async () => {
    const transientStatuses = [503, 204];
    let transientCalls = 0;
    const transient = new RemoteSessionLog('https://api.example.test/projects/p', 'session-1', {}, {
      createAppendId: () => APPEND_ID,
      fetch: async () => response(transientStatuses[transientCalls++]!),
      sleep: async () => {},
    });
    await transient.append({ kind: 'name', name: 'durable' });
    expect(transientCalls).toBe(2);

    let permanentCalls = 0;
    const permanent = new RemoteSessionLog('https://api.example.test/projects/p', 'session-1', {}, {
      createAppendId: () => APPEND_ID,
      fetch: async () => {
        permanentCalls += 1;
        return response(403);
      },
      sleep: async () => {},
    });
    await expect(permanent.append({ kind: 'name', name: 'blocked' })).rejects.toThrow(
      'session log append failed: HTTP 403',
    );
    expect(permanentCalls).toBe(1);
  });

  test('retries a transient replay read and stops on a permanent read failure', async () => {
    const transientStatuses = [503, 200];
    let transientCalls = 0;
    const transient = new RemoteSessionLog('https://api.example.test/projects/p', 'session-1', {}, {
      fetch: async () => {
        const status = transientStatuses[transientCalls++]!;
        return status === 200 ? Response.json([{ kind: 'name', name: 'restored' }]) : response(status);
      },
      sleep: async () => {},
    });
    expect(await transient.read()).toEqual([{ kind: 'name', name: 'restored' }]);
    expect(transientCalls).toBe(2);

    let permanentCalls = 0;
    const permanent = new RemoteSessionLog('https://api.example.test/projects/p', 'session-1', {}, {
      fetch: async () => {
        permanentCalls += 1;
        return response(401);
      },
      sleep: async () => {},
    });
    await expect(permanent.read()).rejects.toThrow('session log read failed: HTTP 401');
    expect(permanentCalls).toBe(1);
  });
});
