'use client';

// React glue over the connector setup policy (KRTX-1012). The hook owns the
// phase machine, subscriptions and cancellation; the host injects the backend
// URL, browser storage and popup opening, so this layer stays free of host
// globals and the core stays framework-free.

import { useEffect, useState } from 'react';

import {
  createConnectorLinkInfoCache,
  nextConnectorPollDelay,
  resolveConnectorStart,
  type LinkInfoStorage,
} from '../core/rest/platform-client/connector-setup';
import {
  finalizeConnectorSetupLink,
  getConnectorSetupLink,
  startConnectorSetupLink,
  type ConnectorSetupLinkInfo,
} from '../core/rest/platform-client/host-boundary';

/**
 * The phases of one connect flow. `ready` shows the connect button, `opened`
 * polls finalize while the provider's popup is up, `connected` is the end.
 */
export type ConnectorSetupPhase = 'loading' | 'error' | 'ready' | 'starting' | 'opened' | 'connected';

/** How the host opens the provider's hosted page. */
export type ConnectorPopupOpener = (url: string) => void;

/** What reading a link's info needs: the cache's adapters. */
export interface ConnectorLinkInfoOptions {
  /** Kortix API base (with or without the `/v1` suffix), as for `HostRequestOptions`. */
  backendUrl: string;
  /** The slice of `Storage` the link-info cache persists through. Null drops persistence. */
  storage?: LinkInfoStorage | null;
}

/** What driving the connect flow needs: the info adapters plus the popup. */
export interface ConnectorSetupOptions extends ConnectorLinkInfoOptions {
  /** Opens the provider's hosted page; the host owns popups, not this hook. */
  openPopup: ConnectorPopupOpener;
  /** Called once per popup opening, after `openPopup`. */
  onOpened?: () => void;
}

// One cache per tab, shared by every card and modal on the link. Created once
// with the first caller's adapters; a host passes the same ones everywhere.
let sharedCache: ReturnType<typeof createConnectorLinkInfoCache> | null = null;

function sharedConnectorLinkInfoCache(options: ConnectorLinkInfoOptions) {
  sharedCache ??= createConnectorLinkInfoCache(
    (token) => getConnectorSetupLink(token, { backendUrl: options.backendUrl }),
    { storage: options.storage ?? null },
  );
  return sharedCache;
}

/**
 * What a connect link names, for the card that renders it.
 *
 * - `undefined` while the GET is in flight (or the token is still streaming):
 *   the card shows a skeleton where the logo goes.
 * - `null` when the GET failed: the card keeps the agent's own label and a
 *   monogram, and the modal reports the error when opened.
 */
export function useConnectorLinkInfo(
  token: string | null,
  options: ConnectorLinkInfoOptions,
): ConnectorSetupLinkInfo | null | undefined {
  const cache = sharedConnectorLinkInfoCache(options);

  // Seeded synchronously from memory or storage, so a link seen before paints
  // its logo on the first frame; the GET below still refreshes it.
  const [info, setInfo] = useState<{
    token: string;
    value: ConnectorSetupLinkInfo | null;
  } | null>(() => {
    const seen = token === null ? undefined : cache.peek(token);
    return token !== null && seen ? { token, value: seen } : null;
  });

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    cache.load(token).then(
      (value) => {
        if (!cancelled) setInfo({ token, value });
      },
      () => {
        // A failed refresh keeps what was already shown; only an unknown link
        // falls back to the monogram.
        if (!cancelled) setInfo((prev) => (prev?.token === token ? prev : { token, value: null }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, cache]);

  if (info && info.token === token) return info.value;
  // A token that changed since mount: read it now rather than show a skeleton.
  return token === null ? undefined : cache.peek(token);
}

/**
 * The connect flow for one link: load what it names, open the provider's hosted
 * page through the injected opener, poll until the connection lands. The host
 * injects the popup opener and the browser storage; the hook owns everything
 * else — the seeded first frame, the single-flight link-info load, the bounded
 * finalize poll and its cancellation.
 */
export function useConnectorSetup(
  token: string,
  options: ConnectorSetupOptions,
) {
  const { backendUrl } = options;
  const cache = sharedConnectorLinkInfoCache(options);

  // Seeded from the link-info cache the chat card already filled (or storage,
  // after a hard refresh), so the dialog opens `ready` with the app's logo on
  // its first frame instead of a loading state.
  const [seed] = useState(() => cache.peek(token));
  const [phase, setPhase] = useState<ConnectorSetupPhase>(seed ? 'ready' : 'loading');
  const [info, setInfo] = useState<ConnectorSetupLinkInfo | null>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  // Bumped every time the popup is opened, so reopening restarts the poll
  // window instead of inheriting an already-expired one.
  const [openedAt, setOpenedAt] = useState(0);
  // Who the account was authorized as, from finalize. Shown on success so a
  // login used by mistake (a personal account on a shared slot) is visible
  // the moment it lands, not months later.
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  // True when /start found the slot already holding an active account. The
  // provider reuses it instead of re-authorizing, so there was no popup.
  const [alreadyConnected, setAlreadyConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await cache.load(token);
        if (cancelled) return;
        setInfo(body);
        setPhase((current) => (current === 'loading' ? 'ready' : current));
      } catch (cause) {
        // A seeded dialog already shows the link; a failed refresh is not an error.
        if (!cancelled && !seed) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not reach Kortix. Check your connection and try again.',
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendUrl, token, seed, cache]);

  // Ask the API whether the connection landed, until it says yes or the poll
  // window closes. One request is in flight at a time by construction: the next
  // timer is only armed after the current one settles. A failed poll is not
  // fatal — the popup may still be open — so it just schedules the next one.
  useEffect(() => {
    if (phase !== 'opened') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let attempt = 0;

    const schedule = () => {
      const delay = nextConnectorPollDelay(attempt, Date.now() - startedAt);
      if (delay === null) return;
      attempt += 1;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      try {
        const body = await finalizeConnectorSetupLink(token, { backendUrl });
        if (cancelled) return;
        if (body.connected) {
          setConnectedAs(body.connected_as ?? null);
          setPhase('connected');
          return;
        }
      } catch {
        // Transient (offline, rate limit, a 502 from the provider) — keep asking.
      }
      if (cancelled) return;
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, openedAt, token, backendUrl]);

  async function connect() {
    setPhase('starting');
    setError(null);
    const outcome = await resolveConnectorStart({
      start: () => startConnectorSetupLink(token, { backendUrl }),
      finalize: () => finalizeConnectorSetupLink(token, { backendUrl }),
    });
    if (outcome.kind === 'error') {
      setError(outcome.message);
      setPhase('ready');
      return;
    }
    if (outcome.kind === 'connected') {
      setAlreadyConnected(outcome.alreadyConnected);
      setConnectedAs(outcome.connectedAs);
      setPhase('connected');
      return;
    }
    options.openPopup(outcome.url);
    setOpenedAt(Date.now());
    setPhase('opened');
    options.onOpened?.();
  }

  return { phase, info, error, connectedAs, alreadyConnected, connect };
}
