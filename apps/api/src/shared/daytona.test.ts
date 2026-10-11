import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Run this file in its own `bun test <file>` invocation (as CI does) so this
// mock never leaks into a sibling file that needs the real config — see the
// same pattern in projects/sandbox-reaper.test.ts.
mock.module('../config', () => ({
  config: {
    DAYTONA_API_KEY: 'test-key',
    DAYTONA_SERVER_URL: 'https://daytona.test/api',
  },
}));

// The timeout tests below need a budget short enough to await: the module
// reads KORTIX_DAYTONA_CALL_TIMEOUT_MS once, at import (floor 1000ms — see
// with-timeout.ts). Set it before the import; delete it after so it cannot
// leak into a sibling file loaded by the same worker.
process.env.KORTIX_DAYTONA_CALL_TIMEOUT_MS = '1000';
const {
  isDaytonaDiskQuotaError,
  archiveDaytonaSandboxById,
  listStoppedDaytonaSandboxesOldestFirst,
} = await import('./daytona');
delete process.env.KORTIX_DAYTONA_CALL_TIMEOUT_MS;

describe('isDaytonaDiskQuotaError', () => {
  test('matches the exact Daytona quota message', () => {
    expect(
      isDaytonaDiskQuotaError(new Error('Total disk limit exceeded. Maximum allowed: 40000GiB.')),
    ).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(isDaytonaDiskQuotaError(new Error('TOTAL DISK LIMIT EXCEEDED for org'))).toBe(true);
  });

  test('matches a plain (non-Error) thrown value', () => {
    expect(isDaytonaDiskQuotaError('total disk limit exceeded')).toBe(true);
  });

  test('does not match an unrelated Daytona error', () => {
    expect(isDaytonaDiskQuotaError(new Error('Sandbox is in an errored state'))).toBe(false);
  });

  test('does not match an unrelated error', () => {
    expect(isDaytonaDiskQuotaError(new Error('network timeout'))).toBe(false);
  });
});

describe('archiveDaytonaSandboxById', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  test('returns true on 200', async () => {
    global.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await archiveDaytonaSandboxById('sb-1')).toBe(true);
  });

  test('treats 409 (already transitioning) as success', async () => {
    global.fetch = mock(async () => new Response(null, { status: 409 })) as unknown as typeof fetch;
    expect(await archiveDaytonaSandboxById('sb-1')).toBe(true);
  });

  test('treats 404 (already gone) as success', async () => {
    global.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await archiveDaytonaSandboxById('sb-1')).toBe(true);
  });

  test('returns false on a hard failure (e.g. unarchivable class)', async () => {
    global.fetch = mock(async () => new Response(null, { status: 400 })) as unknown as typeof fetch;
    expect(await archiveDaytonaSandboxById('sb-1')).toBe(false);
  });

  test('returns false (never throws) on a network exception', async () => {
    global.fetch = mock(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await archiveDaytonaSandboxById('sb-1')).toBe(false);
  });

  test('posts to /sandbox/{id}/archive', async () => {
    let calledUrl = '';
    let calledMethod = '';
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calledUrl = String(url);
      calledMethod = init?.method ?? '';
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await archiveDaytonaSandboxById('sb-42');
    expect(calledUrl).toBe('https://daytona.test/api/sandbox/sb-42/archive');
    expect(calledMethod).toBe('POST');
  });
});

describe('listStoppedDaytonaSandboxesOldestFirst', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  test('requests stopped state sorted oldest-activity-first', async () => {
    let calledUrl = '';
    global.fetch = mock(async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await listStoppedDaytonaSandboxesOldestFirst(10);
    const parsed = new URL(calledUrl);
    expect(parsed.searchParams.get('states')).toBe('stopped');
    expect(parsed.searchParams.get('sort')).toBe('lastActivityAt');
    expect(parsed.searchParams.get('order')).toBe('asc');
  });

  test('paginates via nextCursor until maxItems is reached', async () => {
    const pages = [
      {
        items: [
          { id: 'a', disk: 20, lastActivityAt: '2026-01-01T00:00:00Z' },
          { id: 'b', disk: 20, lastActivityAt: '2026-01-02T00:00:00Z' },
        ],
        nextCursor: 'p2',
      },
      {
        items: [
          { id: 'c', disk: 20, lastActivityAt: '2026-01-03T00:00:00Z' },
          { id: 'd', disk: 20, lastActivityAt: '2026-01-04T00:00:00Z' },
        ],
        nextCursor: 'p3',
      },
    ];
    let call = 0;
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify(pages[call++] ?? { items: [], nextCursor: null }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const out = await listStoppedDaytonaSandboxesOldestFirst(3);
    expect(out.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  test('stops when the API reports no next cursor', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: 'only', disk: 5, lastActivityAt: null }],
            nextCursor: null,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const out = await listStoppedDaytonaSandboxesOldestFirst(200);
    expect(out).toEqual([{ id: 'only', disk: 5, lastActivityAt: null }]);
  });

  test('throws on a non-ok response (never silently returns a partial view)', async () => {
    global.fetch = mock(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(listStoppedDaytonaSandboxesOldestFirst(10)).rejects.toThrow('HTTP 500');
  });
});

// Characterization: every REST fetch in this module must carry an
// AbortSignal.timeout — a hung Daytona connection must settle within the
// configured budget instead of pending forever (the unbounded-hang class
// that wedged the maintenance loop before DAYTONA_REST_CALL_TIMEOUT_MS).
// `settleWithin` resolves with DEADLINE when the budget expires, so a never
// settling call fails fast and explicitly instead of hanging the runner, and
// the deadline itself can never be mistaken for the guard firing.
const DEADLINE = Symbol('deadline');

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(DEADLINE), ms);
    p.then(resolve, resolve).finally(() => clearTimeout(timer));
  });
}

// Budget 1000ms (the env floor set before the import) + the same 5s bound
// the sibling provider test uses.
const SETTLE_BUDGET_MS = 5_000;

describe('REST call timeout', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = originalFetch;
  });

  // A connection to a stalled server: honors the fetch abort contract
  // (rejects with the signal's reason when aborted) but never responds.
  const hungFetch = (_url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<never> => {
    const signal = init?.signal;
    return new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  };

  test('listStoppedDaytonaSandboxesOldestFirst rejects a never-resolving fetch within the budget', async () => {
    global.fetch = Object.assign(mock(hungFetch), { preconnect: originalFetch.preconnect });
    const outcome = await settleWithin(
      listStoppedDaytonaSandboxesOldestFirst(10),
      SETTLE_BUDGET_MS,
    );
    expect(outcome).not.toBe(DEADLINE);
    expect(outcome).toBeInstanceOf(Error);
  });

  test('archiveDaytonaSandboxById returns false on a never-resolving fetch within the budget', async () => {
    global.fetch = Object.assign(mock(hungFetch), { preconnect: originalFetch.preconnect });
    const outcome = await settleWithin(archiveDaytonaSandboxById('sb-1'), SETTLE_BUDGET_MS);
    expect(outcome).toBe(false);
  });
});
