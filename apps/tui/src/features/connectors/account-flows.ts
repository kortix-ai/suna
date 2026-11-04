/**
 * The account writes the `/connectors` screen makes, in the web's order
 * (`useAddAccount`, `useAddManagedAccount`, `useConnectorDetail`), composed
 * from `@kortix/sdk` calls and rules. Nothing here decides a rule of its own:
 * which row is the empty slot, the proposed name, the grants, the connect
 * route and its 409 fallback, the finalize poll and the OAuth sign-in all
 * come from the SDK.
 *
 * A sign-in that needs the browser reports its link through `io.show` and
 * resolves when the account is connected. `io.signal` cancels it (Esc).
 */

import {
  type AdminConnector,
  type Connection,
  type ConnectionOAuth2SignInStart,
  type NewConnectorAccountDraft,
  connectLinkUrl,
  connectorConnectionRows,
  emptyProjectConnectionSlot,
  grantConnectionAccess,
  isManagedConnectorProvider,
  newConnectorAccountGrantees,
  pollConnectLinkFinalize,
  projectConnectionConnectSteps,
  proposeConnectorAccountLabel,
  startConnectionOAuth2SignIn,
  waitForConnectionOAuth2,
} from '@kortix/sdk';

import { kortix } from '../../kortix.ts';

export interface SignInIo {
  signal: AbortSignal;
  /** The page to open, and the code to enter there (a device code). */
  show(link: { url: string; code?: string | null }): void;
}

/** What happens after an account exists. */
export type AccountNext =
  /** Signed in, or nothing to sign in. */
  | { kind: 'ready' }
  /** Enter a credential (masked). `reason`: why no one-click sign-in ran. */
  | { kind: 'credential'; connectionId: string; reason?: string };

function connections(projectId: string) {
  return kortix().project(projectId).connectors.connections;
}

/** Abortable step: rejects with the abort reason as soon as the signal fires. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/**
 * A managed (Composio, Pipedream) account, new or existing: reconcile the row
 * by its label (the same label re-points the same row), write narrowing grants
 * before the link opens, mint the Connect Link, and poll finalize.
 */
export async function connectManagedAccount(
  projectId: string,
  connector: Pick<AdminConnector, 'slug'>,
  input: {
    label: string;
    owner: 'me' | 'project';
    /** Narrowing grants for a new shared account. */
    grantees?: ReturnType<typeof newConnectorAccountGrantees>;
    accountId: string | null;
  },
  io: SignInIo,
): Promise<void> {
  if (input.owner === 'me') {
    const connection = await abortable(
      connections(projectId).reconcileMember({
        connector_alias: connector.slug,
        label: input.label.trim() || 'Private connection',
      }),
      io.signal,
    );
    const start = await abortable(connections(projectId).pipedreamConnect(connection.connection_id), io.signal);
    if (start.connected) return;
    const url = connectLinkUrl(start);
    if (!url) throw new Error('The connector did not return a Connect Link. Try again.');
    io.show({ url });
    await pollConnectLinkFinalize(() => connections(projectId).pipedreamFinalize(connection.connection_id), {
      signal: io.signal,
    });
    return;
  }
  const grantees = input.grantees ?? [];
  const steps = projectConnectionConnectSteps(
    projectId,
    connector.slug,
    input.label,
    undefined,
    grantees.length
      ? (connectionId) => grantConnectionAccess(input.accountId ?? '', projectId, connectionId, grantees)
      : undefined,
  );
  const start = await abortable(steps.start(), io.signal);
  if (start.connected) return;
  const url = connectLinkUrl(start);
  if (!url) throw new Error('The connector did not return a Connect Link. Try again.');
  io.show({ url });
  await pollConnectLinkFinalize(steps.finalize, { signal: io.signal });
}

/**
 * A new account on a direct connector (MCP, OpenAPI, …): narrowed before it
 * holds a credential. "Everyone" reuses the empty shared slot the server made
 * with the connector, so it stays the connector's default.
 */
export async function createDirectAccount(
  projectId: string,
  connector: AdminConnector,
  displayName: string,
  draft: NewConnectorAccountDraft,
  accountId: string | null,
): Promise<Connection> {
  const label = draft.label.trim();
  const api = connections(projectId);
  if (draft.audience === 'private') {
    return api.reconcileMember({ connector_alias: connector.slug, label });
  }
  // Read the list fresh: someone may have signed the slot in since.
  const { connections: all } = await api.list();
  const rows = connectorConnectionRows(all, connector.slug);
  const slot = emptyProjectConnectionSlot(connector, rows);
  const proposal = proposeConnectorAccountLabel(
    displayName,
    rows.map((row) => row.label),
  );
  const connection = !slot
    ? await api.reconcile({ connector_alias: connector.slug, owner_type: 'project', label })
    : label === slot.label || label === proposal
      ? slot
      : await api.rename(slot.connection_id, label);
  if (draft.audience === 'members') {
    await grantConnectionAccess(accountId ?? '', projectId, connection.connection_id, newConnectorAccountGrantees(draft.picked));
  }
  return connection;
}

/**
 * Sign a direct account in: an MCP server's one-click OAuth (a device code,
 * else the authorization link), else a credential typed by hand. A connector
 * with no auth needs nothing.
 */
export async function signInDirectAccount(
  projectId: string,
  connector: AdminConnector,
  connectionId: string,
  returnUrl: string | undefined,
  io: SignInIo,
): Promise<AccountNext> {
  // The web's order (`useAddAccount`): no auth scheme, nothing to sign in.
  if (!connector.authSecret) return { kind: 'ready' };
  if (connector.provider !== 'mcp') return { kind: 'credential', connectionId };
  let start: ConnectionOAuth2SignInStart;
  try {
    start = await abortable(startConnectionOAuth2SignIn(projectId, connectionId, { returnUrl }), io.signal);
  } catch (error) {
    if (io.signal.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'credential', connectionId, reason };
  }
  if (start.kind === 'none') return { kind: 'ready' };
  if (start.kind === 'unavailable') {
    return { kind: 'credential', connectionId, reason: start.reason };
  }
  io.show(start.kind === 'device' ? { url: start.url, code: start.userCode } : { url: start.url });
  await waitForConnectionOAuth2(projectId, connectionId, start, { signal: io.signal });
  return { kind: 'ready' };
}

/** Save a credential typed for one account. */
export function saveAccountCredential(projectId: string, connectionId: string, value: string) {
  return connections(projectId).updateCredential(connectionId, { value: value.trim() });
}

/** Is the sign-in of this connector's accounts a hosted Connect Link? */
export function isManaged(connector: Pick<AdminConnector, 'provider'>): boolean {
  return isManagedConnectorProvider(connector.provider);
}
