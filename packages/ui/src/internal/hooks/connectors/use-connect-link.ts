'use client';

import {
  CONNECT_LINK_POLL_INTERVAL_MS,
  CONNECT_LINK_TIMEOUT_MS,
  connectLinkUrl,
  pollConnectLinkFinalize,
  type ConnectorConnectResult,
  type ConnectorFinalizeResult,
} from '@kortix/sdk';

/** The hosted page's URL. The rule lives in `@kortix/sdk`. */
export { connectLinkUrl };

export interface ConnectLinkFlowOptions {
  openWindow?: () => Window | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function defaultOpenWindow(): Window | null {
  return window.open('', '_blank', 'popup,width=640,height=760');
}

function closePopupSafely(popup: Window): void {
  try {
    if (!popup.closed) popup.close();
  } catch {
    // A cross-origin page or browser policy can reject close(). The connection
    // result must still settle, so cleanup never replaces the real outcome.
  }
}

const POPUP_CLOSED_MESSAGE = 'The connection popup closed before authorization completed.';
const POPUP_WATCH_MS = 500;

/**
 * Rejects as soon as the popup is closed. A request that is still pending when
 * the person closes the window (a slow start or finalize) must not keep the
 * caller's button on a spinner: the flow races every request against this.
 */
function watchPopupClosed(popup: Window): { closed: Promise<never>; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const closed = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      let isClosed = false;
      try {
        isClosed = popup.closed;
      } catch {
        // A browser policy hides `closed`; the finalize poll still sees it.
      }
      if (isClosed) reject(new Error(POPUP_CLOSED_MESSAGE));
    }, POPUP_WATCH_MS);
  });
  // The race below consumes the rejection; this keeps an unraced one quiet.
  closed.catch(() => undefined);
  return { closed, stop: () => clearInterval(timer) };
}

/**
 * Open a blank popup synchronously, request a hosted Connect Link, and poll the
 * normalized finalize endpoint until the provider reports an active account.
 *
 * Opening before the first await preserves browser user activation. Every
 * terminal path closes the popup when the browser permits it.
 */
export async function runConnectLinkFlow(
  start: () => Promise<ConnectorConnectResult>,
  finalize: () => Promise<ConnectorFinalizeResult>,
  options: ConnectLinkFlowOptions = {},
): Promise<{ connected: true }> {
  if (typeof window === 'undefined' && !options.openWindow) {
    throw new Error('Connect Link requires a browser window.');
  }

  const popup = (options.openWindow ?? defaultOpenWindow)();
  if (!popup) {
    // A no-auth toolkit completes in the start response and never needs a
    // browser window. Still attempt it when popups are blocked, but keep OAuth
    // fail-closed because its hosted authorization page cannot be shown.
    const response = await start();
    if (response.connected) return { connected: true };
    throw new Error('Your browser blocked the connection popup. Allow popups and try again.');
  }

  const watcher = watchPopupClosed(popup);
  try {
    // The hosted page does not need access to the Kortix tab through window.opener.
    // Setting this on the same-origin blank page prevents reverse-tabnabbing after
    // navigation while keeping our Window reference for polling cleanup.
    try {
      popup.opener = null;
    } catch {
      // Some browser WindowProxy implementations expose opener as read-only.
    }

    const response = await Promise.race([start(), watcher.closed]);
    if (response.connected) return { connected: true };
    const url = connectLinkUrl(response);
    if (!url) throw new Error('The connector did not return a Connect Link. Try again.');
    if (popup.closed) {
      throw new Error(POPUP_CLOSED_MESSAGE);
    }

    popup.location.replace(url);

    // The SDK's finalize poll (every 2 s, up to 10 min). A closed popup ends
    // it: a pending finalize loses the race against `watcher.closed`, and a
    // finished one that is not connected checks the popup before the next poll.
    return await pollConnectLinkFinalize(
      async () => {
        const result = await Promise.race([finalize(), watcher.closed]);
        if (!result.connected && popup.closed) throw new Error(POPUP_CLOSED_MESSAGE);
        return result;
      },
      {
        sleep: options.sleep ?? defaultSleep,
        now: options.now,
        pollIntervalMs: options.pollIntervalMs ?? CONNECT_LINK_POLL_INTERVAL_MS,
        timeoutMs: options.timeoutMs ?? CONNECT_LINK_TIMEOUT_MS,
      },
    );
  } finally {
    watcher.stop();
    closePopupSafely(popup);
  }
}
