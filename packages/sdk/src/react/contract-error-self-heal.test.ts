/**
 * The fail-safe for a query that settles as error WITHOUT data on a page that
 * stays mounted.
 *
 * Reported 2026-10-04 (#kortix-triage, KRTX-1632): the Models page and project
 * settings — every surface whose reads are gated on the shared
 * `qk.project.detail` entry — sometimes show their loading/empty state
 * forever, and only a manual reload recovers them. The shape: one transient
 * failure (the API answered 5xx once, a network blip, the auth session not
 * published yet) parks the detail entry in `status: 'error'` with no data.
 * Nothing refetches a settled error while its page stays mounted —
 * `refetchOnWindowFocus`/`refetchOnReconnect` are false in the web host and
 * nothing remounts — so every `enabled: <gateway known>` query downstream
 * never fires, and the page sits dead until a reload.
 *
 * The fix lives in the one freshness contract every entity read spreads:
 * `contract()` carries a `refetchInterval` that retries an errored, no-data
 * query with capped exponential backoff. TanStack schedules the interval only
 * while the query is enabled and observed, so a gated query (enabled: false)
 * never fires it, and the first success clears it.
 *
 * These tests drive the REAL TanStack engine with the real hooks, the same
 * harness `use-model-access.test.ts` uses.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { configureKortix } from '../core/http/config';
import { type FreshnessTier, contract } from './query-contracts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// TanStack schedules `refetchInterval` timers only off-server (`isServer()` is
// `typeof window === "undefined"`, captured when query-core first loads), and
// bun tests run without a window — without this the interval these tests exist
// to exercise is never scheduled at all. Defined before the dynamic imports
// below, so query-core reads it at load time.
(globalThis as unknown as { window?: object }).window ??= {};

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useProjectLlmGatewayEnabled } = await import('./use-project-llm-gateway');
const { useProjectModels } = await import('./use-project-models');

// A test that times out never reaches its own `finally { jest.useRealTimers() }`.
// Restore real timers here too, so one stuck test cannot freeze every later
// test's timers (the same guard `connector-setup.test.ts` runs).
afterEach(() => {
  jest.useRealTimers();
});

const DETAIL_BODY = {
  project: {
    id: 'p1',
    account_id: 'a1',
    name: 'Project',
    experimental: { llm_gateway: true },
  },
  config: {},
};

const PICKER_BODY = { providers: [] };

/** Count requests per path so assertions name the wire, not a mock's memory. */
const counts = { detail: 0, picker: 0, other: 0 };
let detailFails = true;
/** The status the failing detail read answers with (500 unless a test sets it). */
let detailStatus = 500;

function installFetch() {
  counts.detail = 0;
  counts.picker = 0;
  counts.other = 0;
  detailFails = true;
  detailStatus = 500;
  globalThis.fetch = (async (url: unknown) => {
    const path = String(url);
    if (path.includes('/detail')) {
      counts.detail += 1;
      if (detailFails) return Response.json({ error: 'server error' }, { status: detailStatus });
      return Response.json(DETAIL_BODY);
    }
    if (path.includes('/model-picker')) {
      counts.picker += 1;
      return Response.json(PICKER_BODY);
    }
    counts.other += 1;
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** Flush every pending microtask chain a fetch cycle leaves behind. */
const flush = async (hops = 30) => {
  for (let hop = 0; hop < hops; hop++) await Promise.resolve();
};

/**
 * The reported scenario end to end: the detail read fails once (HTTP 500), the
 * page stays mounted, then the API recovers. The gates must reopen and the
 * model list must load — with NO remount, NO refocus and NO manual refetch.
 * Today the detail entry parks in error forever, so nothing ever refetches and
 * the picker is never asked: that is the infinite loading state.
 */
test('a failed detail read self-heals on the mounted page and opens the gated model list', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Fake timers from BEFORE the mount: the healing interval must schedule
  // under jest, or advancing fake time would not advance a real interval.
  jest.useFakeTimers();

  let gatewayKnown = false;
  let modelCount = -1;
  function Probe() {
    const gateway = useProjectLlmGatewayEnabled('p1');
    gatewayKnown = gateway.known;
    modelCount = useProjectModels('p1').length;
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });

  // The detail read failed; the page's gates are shut and the picker was never asked.
  expect(counts.detail).toBe(1);
  expect(counts.picker).toBe(0);
  expect(gatewayKnown).toBe(false);

  // The API recovers. Nothing remounts.
  detailFails = false;
  try {
    await act(async () => {
      // Past the first self-heal delay (2 s) and a generous margin; the fetch
      // response lands in the microtask flush, then the state notification's
      // own `setTimeout(0)` (TanStack's notify manager) drains on the next
      // advance so the probe re-renders BEFORE fake timers are torn down.
      jest.advanceTimersByTime(8_000);
      await flush();
      jest.advanceTimersByTime(4_000);
      await flush();
    });
  } finally {
    jest.useRealTimers();
  }

  // Let the healed entry's observers re-render the probe.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
  });
  // The detail entry refetched and now carries data.
  expect(counts.detail).toBeGreaterThan(1);
  expect(gatewayKnown).toBe(true);
  // The gate opened, the model list was fetched, and the page rendered it.
  expect(counts.picker).toBe(1);
  expect(modelCount).toBe(0);

  await act(async () => root?.unmount());
  client.clear();
});

/**
 * The gone-project screen (KRTX-2436): a detail read that answers 404 is a
 * FINAL answer — the project does not exist, and no retry can change that.
 * The self-heal fail-safe above used to treat it like a transient failure and
 * retried it with the same capped backoff, so the gone screen re-asked a dead
 * project every 30 s forever (16 → 18 → 20 requests over 65 s on dev), each
 * with a CORS preflight and a console warning. A final 404 stands down: the
 * entry is asked exactly once and never again while the page stays mounted.
 */
test('a final 404 stands down: the self-heal interval never refires on the mounted page', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  detailStatus = 404;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  jest.useFakeTimers();

  function Probe() {
    useProjectLlmGatewayEnabled('p1');
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });

  // The one and only ask of the dead project.
  expect(counts.detail).toBe(1);

  try {
    await act(async () => {
      // Far past every backoff rung (2 + 4 + 8 + 16 + 30 s) and two more cap
      // intervals: today the interval refires each of these, so this fails.
      jest.advanceTimersByTime(70_000);
      await flush();
      jest.advanceTimersByTime(30_000);
      await flush();
    });
  } finally {
    jest.useRealTimers();
  }

  expect(counts.detail).toBe(1);

  await act(async () => root?.unmount());
  client.clear();
});

/**
 * The same final 404 must not refetch when ANOTHER observer mounts the entry —
 * the mount burst on the gone screen (`retryOnMount` refires a settled error
 * for every new observer, which is how six duplicate detail reads landed in
 * 20 ms on dev). Mounting onto the settled 404 costs zero requests.
 */
test('a final 404 does not refetch when a new observer mounts the settled entry', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  detailStatus = 404;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Probe() {
    useProjectLlmGatewayEnabled('p1');
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });
  expect(counts.detail).toBe(1);

  // Remount: a fresh observer subscribing to the same errored entry.
  await act(async () => root?.unmount());
  let second: ReturnType<typeof create> | undefined;
  await act(async () => {
    second = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  await act(async () => {
    await flush();
  });

  expect(counts.detail).toBe(1);

  await act(async () => second?.unmount());
  client.clear();
});

/**
 * The healing loop stops once data is in: a healthy entry polls nothing. The
 * first success must clear the interval, not keep refetching detail forever.
 */
test('the self-heal interval stands down after the first success', async () => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  installFetch();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.useFakeTimers();
  function Probe() {
    useProjectLlmGatewayEnabled('p1');
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    await flush();
  });
  detailFails = false;
  try {
    await act(async () => {
      jest.advanceTimersByTime(8_000);
      await flush();
    });
    const afterHeal = counts.detail;
    expect(afterHeal).toBeGreaterThan(1);
    await act(async () => {
      jest.advanceTimersByTime(120_000);
      await flush();
    });
    // No further detail reads: the interval was cleared on success.
    expect(counts.detail).toBe(afterHeal);
  } finally {
    jest.useRealTimers();
  }

  await act(async () => root?.unmount());
  client.clear();
});

/**
 * The interval is a no-op for every state a healthy query passes through, and
 * only escalates for the dead one. `contract()` hands this function to
 * TanStack's `refetchInterval` option, which calls it with the Query; the
 * structural subset is what the engine guarantees on every call.
 */
describe('errorSelfHealRefetchInterval', () => {
  const intervalFor = (state: {
    status: string;
    data?: unknown;
    errorUpdateCount: number;
    error?: unknown;
  }) => {
    const fn = contract('config').refetchInterval as unknown as (query: {
      state: typeof state;
    }) => number | false;
    return fn({ state });
  };

  test('never polls a pending, a fulfilled, or a stale-data error entry', () => {
    expect(intervalFor({ status: 'pending', data: undefined, errorUpdateCount: 0 })).toBe(false);
    expect(intervalFor({ status: 'success', data: {}, errorUpdateCount: 0 })).toBe(false);
    expect(intervalFor({ status: 'error', data: { stale: true }, errorUpdateCount: 3 })).toBe(
      false,
    );
  });

  test('retries an errored no-data entry with capped exponential backoff', () => {
    expect(intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1 })).toBe(2_000);
    expect(intervalFor({ status: 'error', data: undefined, errorUpdateCount: 2 })).toBe(4_000);
    expect(intervalFor({ status: 'error', data: undefined, errorUpdateCount: 3 })).toBe(8_000);
    expect(intervalFor({ status: 'error', data: undefined, errorUpdateCount: 7 })).toBe(30_000);
    expect(intervalFor({ status: 'error', data: undefined, errorUpdateCount: 40 })).toBe(30_000);
  });

  test('a transient failure still retries regardless of how the error carries it', () => {
    // A 5xx, a 401/403 (auth publishing, access approval — both recoverable)
    // and a status-less error (network blip) all keep the fail-safe.
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1, error: { status: 500 } }),
    ).toBe(2_000);
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1, error: { status: 401 } }),
    ).toBe(2_000);
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1, error: { status: 403 } }),
    ).toBe(2_000);
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1, error: new Error('x') }),
    ).toBe(2_000);
  });

  test('a final gone answer (404/410) stands down', () => {
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 1, error: { status: 404 } }),
    ).toBe(false);
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 7, error: { status: 410 } }),
    ).toBe(false);
    expect(
      intervalFor({ status: 'error', data: undefined, errorUpdateCount: 40, error: { status: 404 } }),
    ).toBe(false);
  });

  test('every non-directory tier carries it; the directory tier keeps its own poll', () => {
    for (const tier of ['live', 'config', 'inventory', 'volatile'] as FreshnessTier[]) {
      expect(typeof contract(tier).refetchInterval).toBe('function');
    }
    expect(contract('directory').refetchInterval).toBe(10_000);
  });
});
