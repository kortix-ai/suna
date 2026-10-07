// The connector setup-link lifecycle policy: one link-info cache with injected
// storage, one start-outcome rule, one bounded finalize poll schedule. Moved
// from apps/web/src/components/setup-links/ (KRTX-1012) so every host shares it.
// The core stays framework-free: storage is injected, never a DOM global.

import type { ConnectorSetupLinkInfo, ConnectorSetupLinkFinalize, ConnectorSetupLinkStart } from './host-boundary';

/** The slice of `Storage` the cache uses; injected so hosts (and tests) need no DOM. */
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
  { storage }: { storage?: LinkInfoStorage | null } = {},
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

/** What the intake page shows after `/start`. */
export type ConnectorStartOutcome =
  | { kind: 'popup'; url: string }
  | { kind: 'connected'; alreadyConnected: boolean; connectedAs: string | null }
  | { kind: 'error'; message: string };

const START_FAILED = 'Could not start the connect flow.';

/**
 * Decide what one press of "Connect" leads to.
 *
 * A hosted url means a popup. No url but `connected: true` means nothing
 * needs authorizing: the slot already holds an active account, or the toolkit
 * needs no auth. That is success. One finalize then persists it, tells the
 * waiting session, and names who the account is. Only "no url and not
 * connected" is an error.
 *
 * `start` and `finalize` are injected so this rule is testable without the
 * network layer.
 */
export async function resolveConnectorStart(input: {
  start: () => Promise<ConnectorSetupLinkStart>;
  finalize: () => Promise<ConnectorSetupLinkFinalize>;
}): Promise<ConnectorStartOutcome> {
  let started: ConnectorSetupLinkStart;
  try {
    started = await input.start();
  } catch (cause) {
    return { kind: 'error', message: cause instanceof Error ? cause.message : START_FAILED };
  }
  if (started.connect_url) return { kind: 'popup', url: started.connect_url };
  if (!started.connected) return { kind: 'error', message: START_FAILED };

  let connectedAs: string | null = null;
  try {
    connectedAs = (await input.finalize()).connected_as ?? null;
  } catch {
    // The account is connected whether or not this call lands. The next
    // finalize (the modal close, the completion watcher) reconciles it.
  }
  return { kind: 'connected', alreadyConnected: started.already_connected === true, connectedAs };
}

/**
 * Poll schedule for the connector intake's `opened` phase.
 *
 * A hosted connect page runs in a popup we cannot observe, and it has no
 * callback into us — so the only way this window learns the connection landed
 * is to ask the API. `POST /setup-links/connectors/:token/finalize` is that
 * question, and it is also what persists the credential and notifies the
 * requesting session, so the poll is load-bearing, not cosmetic.
 *
 * The first poll waits ~3s (nobody finishes an OAuth faster than that) and the
 * rest run every 5s, inside a 5-minute window. Bounded on purpose: an abandoned
 * tab must stop asking, and the public route is rate-limited to 30 requests per
 * token per minute — 12/min leaves room for a second tab on the same link.
 */
export const CONNECTOR_POLL_FIRST_DELAY_MS = 3_000;
export const CONNECTOR_POLL_INTERVAL_MS = 5_000;
export const CONNECTOR_POLL_WINDOW_MS = 5 * 60_000;

/**
 * Delay before poll number `attempt` (0-based), or `null` when the window has
 * closed and polling must stop. `elapsedMs` is measured from the moment the
 * connect popup was opened.
 */
export function nextConnectorPollDelay(attempt: number, elapsedMs: number): number | null {
  const delay = attempt === 0 ? CONNECTOR_POLL_FIRST_DELAY_MS : CONNECTOR_POLL_INTERVAL_MS;
  if (elapsedMs + delay > CONNECTOR_POLL_WINDOW_MS) return null;
  return delay;
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
