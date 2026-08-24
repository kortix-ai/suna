import { describe, expect, test } from 'bun:test';

import { connectLinkUrl, runConnectLinkFlow } from './use-connect-link';

interface PopupHarness {
  popup: Window;
  navigated: string[];
  closeCalls: number;
  setClosed: (closed: boolean) => void;
}

function popupHarness(options: { closeThrows?: boolean } = {}): PopupHarness {
  let closed = false;
  let closeCalls = 0;
  const navigated: string[] = [];
  const popup = {
    get closed() {
      return closed;
    },
    opener: {},
    location: {
      replace(url: string) {
        navigated.push(url);
      },
    },
    close() {
      closeCalls += 1;
      if (options.closeThrows) throw new Error('browser refused close');
      closed = true;
    },
  } as unknown as Window;
  return {
    popup,
    navigated,
    get closeCalls() {
      return closeCalls;
    },
    setClosed(next) {
      closed = next;
    },
  };
}

describe('connectLinkUrl', () => {
  test('uses the normalized connectUrl before the upstream redirectUrl', () => {
    expect(
      connectLinkUrl({
        connectUrl: 'https://connect.example/a',
        redirectUrl: 'https://connect.example/b',
      }),
    ).toBe('https://connect.example/a');
  });

  test('accepts an upstream redirectUrl during a rolling deploy', () => {
    expect(connectLinkUrl({ redirectUrl: 'https://connect.example/redirect' })).toBe(
      'https://connect.example/redirect',
    );
  });
});

describe('runConnectLinkFlow', () => {
  test('opens a blank popup before requesting the link, navigates it, polls, and closes it', async () => {
    const order: string[] = [];
    const harness = popupHarness();
    let finalizeCalls = 0;

    const result = await runConnectLinkFlow(
      async () => {
        order.push('request');
        return { provider: 'composio', connectUrl: 'https://connect.example/link' };
      },
      async () => {
        order.push('finalize');
        return { connected: ++finalizeCalls === 2 };
      },
      {
        openWindow: () => {
          order.push('open');
          return harness.popup;
        },
        sleep: async () => {},
        now: () => 0,
      },
    );

    expect(result).toEqual({ connected: true });
    expect(order).toEqual(['open', 'request', 'finalize', 'finalize']);
    expect(harness.navigated).toEqual(['https://connect.example/link']);
    expect(harness.closeCalls).toBe(1);
    expect((harness.popup as unknown as { opener: unknown }).opener).toBeNull();
  });

  test('surfaces a popup blocker after confirming the connector still needs OAuth', async () => {
    let requested = false;
    await expect(
      runConnectLinkFlow(
        async () => {
          requested = true;
          return { connected: false, connectUrl: 'https://connect.example/link' };
        },
        async () => ({ connected: true }),
        { openWindow: () => null },
      ),
    ).rejects.toThrow('browser blocked the connection popup');
    expect(requested).toBe(true);
  });

  test('completes a no-auth toolkit without navigation or finalize polling', async () => {
    const harness = popupHarness();
    let finalizeCalls = 0;
    await expect(
      runConnectLinkFlow(
        async () => ({ provider: 'composio', connected: true, isNoAuth: true }),
        async () => {
          finalizeCalls += 1;
          return { connected: true };
        },
        { openWindow: () => harness.popup },
      ),
    ).resolves.toEqual({ connected: true });
    expect(finalizeCalls).toBe(0);
    expect(harness.navigated).toEqual([]);
    expect(harness.closeCalls).toBe(1);
  });

  test('completes a no-auth toolkit even when popups are blocked', async () => {
    await expect(
      runConnectLinkFlow(
        async () => ({ provider: 'composio', connected: true, isNoAuth: true }),
        async () => ({ connected: true }),
        { openWindow: () => null },
      ),
    ).resolves.toEqual({ connected: true });
  });

  test('surfaces a user-closed popup and does not leave the mutation pending', async () => {
    const harness = popupHarness();
    let finalizeCalls = 0;
    await expect(
      runConnectLinkFlow(
        async () => ({ connectUrl: 'https://connect.example/link' }),
        async () => {
          finalizeCalls += 1;
          harness.setClosed(true);
          return { connected: false };
        },
        { openWindow: () => harness.popup, sleep: async () => {}, now: () => 0 },
      ),
    ).rejects.toThrow('closed before authorization completed');
    expect(finalizeCalls).toBe(1);
  });

  test('surfaces the authorization timeout and closes the popup', async () => {
    const harness = popupHarness();
    let now = 0;
    await expect(
      runConnectLinkFlow(
        async () => ({ connectUrl: 'https://connect.example/link' }),
        async () => ({ connected: false }),
        {
          openWindow: () => harness.popup,
          sleep: async (ms) => {
            now += ms;
          },
          now: () => now,
          pollIntervalMs: 10,
          timeoutMs: 20,
        },
      ),
    ).rejects.toThrow('Authorization timed out');
    expect(harness.closeCalls).toBe(1);
  });

  test('closes a pre-opened popup when the start request fails', async () => {
    const harness = popupHarness();
    await expect(
      runConnectLinkFlow(
        async () => {
          throw new Error('start failed');
        },
        async () => ({ connected: false }),
        { openWindow: () => harness.popup },
      ),
    ).rejects.toThrow('start failed');
    expect(harness.closeCalls).toBe(1);
  });

  test('never lets a browser close exception mask a successful connection', async () => {
    const harness = popupHarness({ closeThrows: true });
    await expect(
      runConnectLinkFlow(
        async () => ({ connectUrl: 'https://connect.example/link' }),
        async () => ({ connected: true }),
        { openWindow: () => harness.popup },
      ),
    ).resolves.toEqual({ connected: true });
  });

  test('requires a Connect Link URL and closes the blank popup', async () => {
    const harness = popupHarness();
    await expect(
      runConnectLinkFlow(
        async () => ({}),
        async () => ({ connected: true }),
        {
          openWindow: () => harness.popup,
        },
      ),
    ).rejects.toThrow('did not return a Connect Link');
    expect(harness.closeCalls).toBe(1);
  });
});
