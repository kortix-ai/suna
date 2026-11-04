/**
 * What state a project connector is in, and how a surface names it: its setup
 * status, the three-state tone every list shows (Connected, Needs account,
 * Error), its provider's label, and whether its accounts sign in through a
 * managed partner (Composio, Pipedream).
 *
 * Pure and framework-free. The web connectors pages (`packages/ui`) and the
 * TUI's `/connectors` screen read the same rules from here, so a connector
 * never reads "Connected" on one surface and "Needs account" on the other.
 */

import type { AdminConnector } from '../rest/projects-client/connectors';

export type ConnectorSetupStatus =
  | 'connected'
  | 'error'
  /** An MCP server asked for sign-in (401/403) and nobody has signed in yet. */
  | 'pending'
  | 'needs_setup'
  | 'no_auth';

/** A sync error that is the server asking for sign-in: HTTP 401 or 403. */
export function isConnectorAuthChallenge(error: string): boolean {
  return /\bHTTP 40[13]\b|\bunauthori[sz]ed\b/i.test(error);
}

export function connectorSetupStatus(
  connector: Pick<AdminConnector, 'authorizationStrategy' | 'authSecret' | 'secretSet' | 'status'> &
    Partial<Pick<AdminConnector, 'provider' | 'lastError'>>,
): ConnectorSetupStatus {
  // An MCP server that signs in with OAuth answers 401 until someone signs in.
  // That is setup still in progress, not a failure.
  if (
    connector.status === 'error' &&
    connector.provider === 'mcp' &&
    !connector.secretSet &&
    isConnectorAuthChallenge(connector.lastError ?? '')
  )
    return 'pending';
  if (connector.status === 'error') return 'error';
  // An authorization that never completed is setup that never finished. This
  // used to fall through to the `authSecret`/`secretSet` branches, so an
  // unauthorized connector still rendered `connected` while the gateway refused
  // every tool call against it with `needs_auth`. Prod 2026-08-28: 6 of 6
  // GitHub connections had no connected account and no GitHub tool call had
  // ever run.
  if (connector.status === 'needs_auth') return 'needs_setup';
  if (!connector.authSecret) return 'no_auth';
  // A per-person connector (`authorizationStrategy: 'user'`) has no project
  // credential to check. Its `status` is computed for the caller: `active`
  // means the caller's own account holds one, `needs_auth` (above) that it
  // does not. So it is connected here.
  if (connector.authorizationStrategy === 'user') return 'connected';
  return connector.secretSet ? 'connected' : 'needs_setup';
}

/**
 * The three states a connector shows, everywhere it shows one (the list card,
 * the connector header, the app page): Connected, Needs account, Error. A
 * sign-in still to finish and a missing credential are both "Needs account":
 * adding or signing in an account is the fix in either case.
 */
export type ConnectorStatusTone = 'connected' | 'account' | 'error';

/** The server's derived state (`state` on the connector). `disabled` reads as an error. */
export type ConnectorDerivedState = 'needs_account' | 'connected' | 'error';

export function connectorDerivedState(connector: object): ConnectorDerivedState | null {
  const state = (connector as { state?: unknown }).state;
  if (state === 'disabled') return 'error';
  return state === 'needs_account' || state === 'connected' || state === 'error' ? state : null;
}

/**
 * The server's `state` when it sends one. An older API: the same rule from the
 * fields, where zero accounts (once loaded) is Needs account.
 */
export function connectorStatusTone(
  connector: Pick<AdminConnector, 'authorizationStrategy' | 'authSecret' | 'secretSet' | 'status'> &
    Partial<Pick<AdminConnector, 'provider' | 'lastError'>>,
  /** The accounts the caller can see, once loaded. */
  accountCount?: number,
): ConnectorStatusTone {
  const state = connectorDerivedState(connector);
  if (state === 'error') return 'error';
  if (state === 'needs_account') return 'account';
  // A channel or computer has no accounts to count. Anything else with zero
  // loaded accounts has nothing to run as, whatever else it reports.
  const counted = connector.provider !== 'channel' && connector.provider !== 'computer';
  if (counted && accountCount === 0) return 'account';
  if (state === 'connected') return 'connected';
  const status = connectorSetupStatus(connector);
  if (status === 'error') return 'error';
  if (status === 'pending' || status === 'needs_setup') return 'account';
  return 'connected';
}

/**
 * Agents can use the connector now: it is signed in, it runs on per-person
 * accounts, or it needs no sign-in and has an account to run as.
 */
export function connectorUsable(status: ConnectorSetupStatus, accountCount: number): boolean {
  if (status === 'connected') return true;
  return status === 'no_auth' && accountCount > 0;
}

/**
 * Forward-facing provider label. A managed connector names its partner
 * (Composio, Pipedream): it is never just an "App".
 */
export function connectorProviderLabel(provider: AdminConnector['provider']): string {
  if (provider === 'composio') return 'Composio';
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'channel') return 'Channel';
  if (provider === 'computer') return 'Computer';
  if (provider === 'postman') return 'Postman';
  // The catalogue's words for the same ways in.
  if (provider === 'openapi') return 'REST API';
  if (provider === 'graphql') return 'GraphQL';
  if (provider === 'http') return 'HTTP API';
  return provider.toUpperCase();
}

/** Providers whose accounts are authorized through the normalized Connect Link gateway. */
export function isManagedConnectorProvider(provider: AdminConnector['provider']): boolean {
  return provider === 'composio' || provider === 'pipedream';
}

/** The name a connector shows: its display name, else its slug. */
export function connectorDisplayName(connector: Pick<AdminConnector, 'name' | 'slug'>): string {
  return connector.name?.trim() || connector.slug;
}
