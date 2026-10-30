'use client';

import type { ConnectorConnectResult, ConnectorFinalizeResult } from '@kortix/sdk';

export interface ConnectLinkFlowOptions {
  openWindow?: () => Window | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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

function timeoutMessage(timeoutMs: number): string {
  const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return `Authorization timed out after ${minutes} minute${minutes === 1 ? '' : 's'}. Try again.`;
}

export function connectLinkUrl(response: ConnectorConnectResult): string | null {
  return response.connectUrl || response.redirectUrl || null;
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

    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = now() + timeoutMs;

    while (true) {
      const result = await Promise.race([finalize(), watcher.closed]);
      if (result.connected) return { connected: true };
      if (popup.closed) {
        throw new Error(POPUP_CLOSED_MESSAGE);
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw new Error(timeoutMessage(timeoutMs));
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  } finally {
    watcher.stop();
    closePopupSafely(popup);
  }
}
