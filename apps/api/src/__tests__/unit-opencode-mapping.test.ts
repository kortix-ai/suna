import { afterEach, describe, expect, mock, test } from 'bun:test';

import { projectSessions } from '@kortix/db';

const dbUpdates: Array<Record<string, unknown>> = [];
mock.module('../shared/db', () => ({
  db: {
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: async () => {
          if (table === projectSessions) dbUpdates.push(updates);
          return [];
        },
      }),
    }),
  },
}));

mock.module('../sandbox-proxy/backend', () => ({
  resolveServiceKey: async () => 'svc-key',
  resolveSandboxIngress: async () => ({
    url: 'https://sandbox.test',
    headers: {},
    effectivePort: 8000,
  }),
}));

mock.module('../shared/preview-ownership', () => ({
  resolvePreviewUserContext: async () => null,
}));

const { ensureOpencodeSessionPin } = await import('../projects/opencode-mapping');

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ method: string; url: string }> = [];

afterEach(() => {
  dbUpdates.length = 0;
  fetchCalls.length = 0;
  globalThis.fetch = originalFetch;
});

function mockSessionList(sessions: unknown[]) {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ method: init?.method ?? 'GET', url: String(url) });
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('ensureOpencodeSessionPin', () => {
  test('does not create an API-side root when the sandbox has not bootstrapped one yet', async () => {
    mockSessionList([]);

    const result = await ensureOpencodeSessionPin({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      externalId: 'box-1',
      userId: 'user-1',
      currentPin: null,
    });

    expect(result).toMatchObject({ pin: null, changed: false, reason: 'not_ready' });
    expect(fetchCalls.map((call) => call.method)).toEqual(['GET']);
    expect(dbUpdates).toHaveLength(0);
  });

  test('adopts an existing sandbox root and persists the pin', async () => {
    mockSessionList([{ id: 'ses_root', time: { created: 1, updated: 2 } }]);

    const result = await ensureOpencodeSessionPin({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      accountId: 'acct-1',
      externalId: 'box-1',
      userId: 'user-1',
      currentPin: null,
    });

    expect(result).toMatchObject({ pin: 'ses_root', changed: true, reason: 'healed' });
    expect(fetchCalls.map((call) => call.method)).toEqual(['GET']);
    expect(dbUpdates.at(-1)).toMatchObject({ opencodeSessionId: 'ses_root' });
  });
});
