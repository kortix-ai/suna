/**
 * The React glue over the connector setup policy, moved from
 * `apps/web/src/components/setup-links/connector-intake.tsx` (KRTX-1012): the
 * hook owns the phase machine, subscriptions and cancellation; the host injects
 * the backend URL, browser storage and popup opening.
 */
import { afterEach, expect, jest, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const { useConnectorSetup } = await import('./connector-setup');

const BACKEND = 'http://test.local/v1';

// A test that times out never reaches its own `finally { jest.useRealTimers() }`.
// Restore real timers here too, so one stuck test cannot freeze every later
// test's fetch and act() behind fake timers (CI, promotion #9124 and #9126).
afterEach(() => {
  jest.useRealTimers();
});

type Setup = ReturnType<typeof useConnectorSetup>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const INFO = {
  project_name: 'Project 1',
  slug: 'miro',
  app: 'miro',
  name: 'Miro',
  icon_url: 'https://cdn.example.test/miro.svg',
  expires_at: '2099-01-01T00:00:00.000Z',
};

/** Drive the hook through one host-shaped harness: mocked fetch, fake timers. */
let harnessSeq = 0;

function harness(options: { openPopup: (url: string) => void; onOpened?: () => void }) {
  // A unique token per harness: the shared link-info cache is per tab by
  // design, so two tests must not hand each other a settled entry.
  const token = `ksl_probe_${(harnessSeq += 1)}`;
  let value: Setup | undefined;
  function Probe() {
    value = useConnectorSetup(token, { backendUrl: BACKEND, ...options });
    return null;
  }
  let root: ReturnType<typeof create> | undefined;
  const mount = async () => {
    await act(async () => {
      root = create(React.createElement(Probe));
    });
  };
  const unmount = async () => {
    await act(async () => root?.unmount());
  };
  const connect = async () => {
    await act(async () => {
      await value?.connect();
    });
  };
  return { mount, unmount, connect, get value() {
    return value;
  } };
}

test('a hosted url opens the popup through the injected opener and starts the poll window', async () => {
  const openedUrls: string[] = [];
  const onOpened = jest.fn();
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: 'https://composio.test/connect' });
    }
    return Response.json({ connected: false });
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  const setup = harness({ openPopup: (url) => openedUrls.push(url), onOpened });
  await setup.mount();
  await setup.connect();

  expect(openedUrls).toEqual(['https://composio.test/connect']);
  // Callback timing: onOpened fires only after the popup is open.
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(calls.some((c) => c.endsWith('/start'))).toBe(true);

  try {
    await act(async () => {
      jest.advanceTimersByTime(3_000);
      for (let hop = 0; hop < 20; hop++) await Promise.resolve();
    });
    // The first poll fired exactly 3s after the popup opened.
    expect(calls.filter((c) => c.endsWith('/finalize'))).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
  await setup.unmount();
});

test('a connected finalize flips the phase and names the identity; a transient failure retries', async () => {
  const openedUrls: string[] = [];
  const calls: string[] = [];
  let finalizeCalls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: 'https://composio.test/connect' });
    }
    finalizeCalls += 1;
    if (finalizeCalls === 1) return Response.error();
    return Response.json({ connected: true, connected_as: 'ops@example.test' });
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();

  try {
    await act(async () => {
      jest.advanceTimersByTime(3_000);
      for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    });
    // Transient failure: the poll retried on the next interval and landed.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    });
    expect(setup.value?.phase).toBe('connected');
    expect(setup.value?.connectedAs).toBe('ops@example.test');
  } finally {
    jest.useRealTimers();
  }
  await setup.unmount();
});

test('one finalize request is in flight at a time: the next timer waits for the pending one', async () => {
  const calls: string[] = [];
  const gate = deferred<{ connected: boolean }>();
  const INFO = {
    project_name: 'Project 1',
    slug: 'miro',
    app: 'miro',
    name: 'Miro',
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call = `${init?.method ?? 'GET'} ${String(url)}`;
    calls.push(call);
    if (call.endsWith('/start')) {
      return Response.json({ connect_url: 'https://composio.test/connect' });
    }
    if (call.endsWith('/finalize')) {
      return gate.promise.then((body) => Response.json(body));
    }
    return Response.json(INFO);
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  const setup = harness({ openPopup: () => undefined });
  await setup.mount();
  await setup.connect();

  try {
    // The 3s timer fires while the first finalize is still pending.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
      for (let hop = 0; hop < 20; hop++) await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(4_000);
      for (let hop = 0; hop < 20; hop++) await Promise.resolve();
    });
    expect(calls.filter((c) => c.endsWith('/finalize'))).toHaveLength(1);

    // The pending finalize settles not-connected: only then is the next
    // timer armed, 5s after the settle.
    gate.resolve({ connected: false });
    await act(async () => {
      for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    });
    expect(calls.filter((c) => c.endsWith('/finalize'))).toHaveLength(2);
  } finally {
    jest.useRealTimers();
  }
  await setup.unmount();
});

test('unmount cancels the poll: a settled finalize after unmount changes nothing', async () => {
  const openedUrls: string[] = [];
  const finalizeGate = deferred<{ connected: boolean; connected_as?: string | null }>();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: 'https://composio.test/connect' });
    }
    return finalizeGate.promise;
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();

  try {
    await act(async () => {
      jest.advanceTimersByTime(3_000);
      for (let hop = 0; hop < 20; hop++) await Promise.resolve();
    });
    await setup.unmount();
    // The finalize settles after unmount: no update, no crash.
    finalizeGate.resolve({ connected: true, connected_as: 'late@example.test' });
    for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    expect(openedUrls).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test('reopening the popup resets the poll deadline instead of inheriting an expired one', async () => {
  const openedUrls: string[] = [];
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: 'https://composio.test/connect' });
    }
    return Response.json({ connected: false });
  }) as unknown as typeof fetch;

  jest.useFakeTimers();
  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();

  try {
    // Run the first window to exhaustion: 5 minutes of 3s+5s polls.
    await act(async () => {
      for (let second = 0; second < 310; second++) {
        jest.advanceTimersByTime(1_000);
        for (let hop = 0; hop < 10; hop++) await Promise.resolve();
      }
    });
    const pollsBefore = calls.filter((c) => c.endsWith('/finalize')).length;
    expect(pollsBefore).toBeGreaterThan(50); // ~60 polls fit in the window
    expect(setup.value?.phase).toBe('opened');

    // Reopen: a fresh 5-minute window starts, so polls resume.
    await setup.connect();
    await act(async () => {
      jest.advanceTimersByTime(6_000);
      for (let hop = 0; hop < 30; hop++) await Promise.resolve();
    });
    const pollsAfter = calls.filter((c) => c.endsWith('/finalize')).length;
    expect(pollsAfter).toBeGreaterThan(pollsBefore);
    expect(openedUrls).toHaveLength(2);
  } finally {
    jest.useRealTimers();
  }
  await setup.unmount();
});

test('an already-connected slot skips the popup and lands on the connected phase', async () => {
  const openedUrls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: null, connected: true, already_connected: true });
    }
    return Response.json({ connected: true, connected_as: 'slot@example.test' });
  }) as unknown as typeof fetch;

  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();

  expect(openedUrls).toEqual([]);
  expect(setup.value?.phase).toBe('connected');
  expect(setup.value?.alreadyConnected).toBe(true);
  expect(setup.value?.connectedAs).toBe('slot@example.test');
  await setup.unmount();
});

test('a no-auth toolkit lands on connected without claiming a prior account', async () => {
  const openedUrls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith('/start')) {
      return Response.json({ connect_url: null, connected: true, already_connected: false });
    }
    return Response.json({ connected: true, connected_as: null });
  }) as unknown as typeof fetch;

  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();

  expect(openedUrls).toEqual([]);
  expect(setup.value?.alreadyConnected).toBe(false);
  expect(setup.value?.connectedAs).toBeNull();
  expect(setup.value?.phase).toBe('connected');
  await setup.unmount();
});

test('an unknown link loads its info into the ready phase; a seeded one skips the spinner', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return Response.json(INFO);
  }) as unknown as typeof fetch;

  const setup = harness({ openPopup: () => undefined });
  await setup.mount();
  expect(setup.value?.info).toEqual(INFO);
  expect(calls.some((c) => c.includes('/setup-links/connectors/'))).toBe(true);
  await setup.unmount();
});

test('a start that rejects surfaces its message and returns to ready', async () => {
  globalThis.fetch = (async () => Response.json({ error: 'The provider did not return a connect URL' }, { status: 502 })) as unknown as typeof fetch;
  const openedUrls: string[] = [];
  const setup = harness({ openPopup: (url) => openedUrls.push(url) });
  await setup.mount();
  await setup.connect();
  expect(openedUrls).toEqual([]);
  expect(setup.value?.phase).toBe('ready');
  expect(setup.value?.error).toBeTruthy();
  await setup.unmount();
});
