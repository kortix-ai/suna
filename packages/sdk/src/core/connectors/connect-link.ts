/**
 * Signing a managed (Composio, Pipedream) connector account in through its
 * hosted Connect Link: which route mints the link for a shared account, and
 * the finalize poll that waits for the provider to report the account active.
 *
 * Host-free: a browser opens the link in a popup, a terminal prints it and
 * opens the system browser. Both poll with `pollConnectLinkFinalize`.
 */

import {
  type ConnectorConnectResult,
  type ConnectorFinalizeResult,
  connectorConnect,
  connectorFinalize,
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileConnection,
} from '../rest/projects-client/connectors';

/** How often the finalize route is polled while the person signs in. */
export const CONNECT_LINK_POLL_INTERVAL_MS = 2_000;
/** How long a sign-in may take before the wait gives up. */
export const CONNECT_LINK_TIMEOUT_MS = 10 * 60_000;

/** The hosted page to send the person to, or null when the start returned none. */
export function connectLinkUrl(response: ConnectorConnectResult): string | null {
  return response.connectUrl || response.redirectUrl || null;
}

/** "Authorization timed out after 10 minutes. Try again." */
export function connectLinkTimeoutMessage(timeoutMs: number): string {
  const minutes = Math.max(1, Math.ceil(timeoutMs / 60_000));
  return `Authorization timed out after ${minutes} minute${minutes === 1 ? '' : 's'}. Try again.`;
}

export interface ConnectLinkPollOptions {
  /** Ends the wait with `signal.reason`, even while a request is in flight. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The sign-in was cancelled.');
}

/** Race one step against the abort signal. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `finalize` every 2 s until the provider reports the account connected,
 * up to 10 minutes. Rejects with the timeout message, a finalize error, or the
 * abort reason.
 */
export async function pollConnectLinkFinalize(
  finalize: () => Promise<ConnectorFinalizeResult>,
  options: ConnectLinkPollOptions = {},
): Promise<{ connected: true }> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? CONNECT_LINK_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? CONNECT_LINK_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  while (true) {
    const result = await raceAbort(finalize(), options.signal);
    if (result.connected) return { connected: true };
    if (options.signal?.aborted) throw abortReason(options.signal);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error(connectLinkTimeoutMessage(timeoutMs));
    await raceAbort(sleep(Math.min(pollIntervalMs, remainingMs)), options.signal);
  }
}

// ─── A shared account's connect route ────────────────────────────────────────

/**
 * Which connect route authorized the account, so finalize polls the same one.
 *
 * @deprecated Use `WorkspaceConnectRoute`. Kept permanently.
 */
export type ProjectConnectRoute = 'connection' | 'connector';

/** The workspace name of {@link ProjectConnectRoute}: the same type. */
export type WorkspaceConnectRoute = ProjectConnectRoute;

/** @deprecated Use `WorkspaceConnectionConnectDeps`. Kept permanently. */
export interface ProjectConnectionConnectDeps {
  reconcile: (
    projectId: string,
    input: { connector_alias: string; owner_type: 'project'; label: string },
  ) => Promise<{ connection_id: string }>;
  connectConnection: (projectId: string, connectionId: string) => Promise<ConnectorConnectResult>;
  finalizeConnection: (projectId: string, connectionId: string) => Promise<ConnectorFinalizeResult>;
  connectConnector: (
    projectId: string,
    slug: string,
    options: { owner: 'project' },
  ) => Promise<ConnectorConnectResult>;
  finalizeConnector: (
    projectId: string,
    slug: string,
    options: { owner: 'project'; connectionId: string },
  ) => Promise<ConnectorFinalizeResult>;
}

/** The workspace name of {@link ProjectConnectionConnectDeps}: the same type. */
export type WorkspaceConnectionConnectDeps = ProjectConnectionConnectDeps;

/** @deprecated Use `DEFAULT_WORKSPACE_CONNECTION_LABEL`. Kept permanently. */
export const DEFAULT_PROJECT_CONNECTION_LABEL = 'Project connection';

/** The workspace name of {@link DEFAULT_PROJECT_CONNECTION_LABEL}: the same value. */
export const DEFAULT_WORKSPACE_CONNECTION_LABEL = DEFAULT_PROJECT_CONNECTION_LABEL;

/**
 * The REST calls `projectConnectionConnectSteps` makes by default.
 *
 * @deprecated Use `workspaceConnectionConnectRestDeps`. Kept permanently.
 */
export const projectConnectionConnectRestDeps: ProjectConnectionConnectDeps = {
  reconcile: reconcileConnection,
  connectConnection: (projectId, connectionId) => pipedreamConnectConnection(projectId, connectionId),
  finalizeConnection: pipedreamFinalizeConnection,
  connectConnector: connectorConnect,
  finalizeConnector: connectorFinalize,
};

/** The workspace name of {@link projectConnectionConnectRestDeps}: the same value. */
export const workspaceConnectionConnectRestDeps = projectConnectionConnectRestDeps;

/**
 * Did the connection-scoped connect route refuse because this account is the
 * connector's EFFECTIVE project default? The API blocks that route for the
 * connector's sole active project-owned row and names the route to use
 * instead. That guard is the only 409 the handler returns, so the status
 * alone identifies it. Read structurally, never with `instanceof ApiError`: a
 * consumer that loads the ESM build and the IIFE global has two classes.
 */
export function isSharedDefaultConnectConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

/**
 * The `start`/`finalize` pair for a project-owned (shared) account. `start`
 * reconciles the row with its label (creating it, or re-pointing the same
 * one), runs `beforeAuthorize` (where narrowing grants are written, so the
 * account never holds a credential while open to everyone), then mints the
 * Connect Link; on the default-account 409 it uses the connector route.
 */
export function workspaceConnectionConnectSteps(
  projectId: string,
  slug: string,
  label: string | undefined,
  deps: ProjectConnectionConnectDeps = projectConnectionConnectRestDeps,
  beforeAuthorize?: (connectionId: string) => Promise<void>,
): {
  start: () => Promise<ConnectorConnectResult>;
  finalize: () => Promise<ConnectorFinalizeResult>;
  /** The account `start` created, or `null` before it ran. */
  connectionId: () => string | null;
} {
  let connectionId: string | null = null;
  let route: ProjectConnectRoute = 'connection';

  return {
    start: async () => {
      const connection = await deps.reconcile(projectId, {
        connector_alias: slug,
        owner_type: 'project',
        label: label?.trim() || DEFAULT_PROJECT_CONNECTION_LABEL,
      });
      connectionId = connection.connection_id;
      await beforeAuthorize?.(connection.connection_id);
      try {
        return await deps.connectConnection(projectId, connection.connection_id);
      } catch (error) {
        if (!isSharedDefaultConnectConflict(error)) throw error;
        // Only the default account is redirected: `owner: 'project'` resolves
        // that SAME row, so a labelled non-default account never lands here.
        route = 'connector';
        return await deps.connectConnector(projectId, slug, { owner: 'project' });
      }
    },
    finalize: () => {
      if (!connectionId) throw new Error('The project connection was not created.');
      // The owner MUST match the connect: the connector route defaults an
      // absent owner to `me`. `connectionId` pins the poll to the reconciled row.
      if (route === 'connector') {
        return deps.finalizeConnector(projectId, slug, { owner: 'project', connectionId });
      }
      return deps.finalizeConnection(projectId, connectionId);
    },
    connectionId: () => connectionId,
  };
}

/** @deprecated Use `workspaceConnectionConnectSteps`. Kept permanently. */
export const projectConnectionConnectSteps = workspaceConnectionConnectSteps;
