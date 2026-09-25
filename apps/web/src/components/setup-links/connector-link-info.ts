'use client';

import { getConnectorSetupLink, type ConnectorSetupLinkInfo } from '@kortix/sdk';
import { useEffect, useState } from 'react';

import { setupLinkApiBase } from './util';

/** The slice of `Storage` the cache uses; injectable so tests need no DOM. */
export interface LinkInfoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = 'kortix:connect-link:';

/**
 * A stable, non-reversible key for a token. The token is a live bearer
 * capability, so it is never written to storage; only this digest is. FNV-1a
 * over the whole token, twice with different seeds, for 64 bits.
 */
function storageKey(token: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ token.length;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${STORAGE_PREFIX}${a.toString(36)}${b.toString(36)}`;
}

function browserStorage(): LinkInfoStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * One in-flight or settled GET per link token, shared by every card that shows
 * it and by the connect modal. A message can hold several connect cards, and the
 * same link can appear in a streaming and a settled render of one message;
 * without this each would ask the rate-limited public route on its own.
 *
 * Instant by design: `peek` answers synchronously from memory, then from
 * `storage`, so a card on a hard refresh and a modal opened from a card both
 * paint the app's logo on their first frame. A link never seen before is the
 * only case that waits for the network.
 *
 * What is stored: the link info (name, logo URL, project, expiry), none of it
 * secret, keyed by a digest of the token, never the token. An entry past the
 * link's `expires_at` is ignored and removed. A rejected request is dropped, so
 * a card mounted after a blip asks again instead of inheriting the failure.
 * Storage that throws (private mode, blocked) degrades to memory only.
 */
export function createConnectorLinkInfoCache(
  fetchInfo: (token: string) => Promise<ConnectorSetupLinkInfo>,
  { storage = browserStorage() }: { storage?: LinkInfoStorage | null } = {},
) {
  const requests = new Map<string, Promise<ConnectorSetupLinkInfo>>();
  const settled = new Map<string, ConnectorSetupLinkInfo>();

  const readStored = (token: string): ConnectorSetupLinkInfo | undefined => {
    if (!storage) return undefined;
    try {
      const raw = storage.getItem(storageKey(token));
      if (!raw) return undefined;
      const value = JSON.parse(raw) as ConnectorSetupLinkInfo;
      if (Date.parse(value.expires_at) <= Date.now()) {
        storage.removeItem(storageKey(token));
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  };

  const writeStored = (token: string, value: ConnectorSetupLinkInfo): void => {
    if (!storage) return;
    try {
      storage.setItem(storageKey(token), JSON.stringify(value));
    } catch {
      // Quota or blocked storage: memory still serves this page.
    }
  };

  return {
    peek(token: string): ConnectorSetupLinkInfo | undefined {
      const inMemory = settled.get(token);
      if (inMemory) return inMemory;
      const stored = readStored(token);
      if (stored) settled.set(token, stored);
      return stored;
    },
    load(token: string): Promise<ConnectorSetupLinkInfo> {
      const pending = requests.get(token);
      if (pending) return pending;
      const request = fetchInfo(token).then(
        (value) => {
          settled.set(token, value);
          writeStored(token, value);
          return value;
        },
        (cause: unknown) => {
          requests.delete(token);
          throw cause;
        },
      );
      requests.set(token, request);
      return request;
    },
  };
}

const sharedCache = createConnectorLinkInfoCache((token) =>
  getConnectorSetupLink(token, { backendUrl: setupLinkApiBase() }),
);

/** The shared cache's synchronous read, for the modal's first frame. */
export function peekConnectorLinkInfo(token: string): ConnectorSetupLinkInfo | undefined {
  return sharedCache.peek(token);
}

/** The shared cache's load, so the modal and the cards share one request. */
export function loadConnectorLinkInfo(token: string): Promise<ConnectorSetupLinkInfo> {
  return sharedCache.load(token);
}

/**
 * The words a connect card leads with: the app's display name, then the
 * provider app id, then the slug. `project` is null when the server did not
 * name one — the API answers "this project" for a project it cannot find.
 */
export function connectorHeadline(info: ConnectorSetupLinkInfo): {
  app: string;
  project: string | null;
} {
  const project = info.project_name?.trim();
  return {
    app: info.name?.trim() || info.app?.trim() || info.slug,
    project: project && project !== 'this project' ? project : null,
  };
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
): ConnectorSetupLinkInfo | null | undefined {
  // Seeded synchronously from memory or storage, so a link seen before paints
  // its logo on the first frame; the GET below still refreshes it.
  const [info, setInfo] = useState<{
    token: string;
    value: ConnectorSetupLinkInfo | null;
  } | null>(() => {
    const seen = token === null ? undefined : sharedCache.peek(token);
    return token !== null && seen ? { token, value: seen } : null;
  });

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    sharedCache.load(token).then(
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
  }, [token]);

  if (info && info.token === token) return info.value;
  // A token that changed since mount: read it now rather than show a skeleton.
  return token === null ? undefined : sharedCache.peek(token);
}
