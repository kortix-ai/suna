import type { AdminConnector } from '@kortix/sdk';

import {
  connectorSetupStatus,
  type ConnectorSetupStatus,
} from '../../sections/connector-connection-form';

import { providerLabel } from '../provider-label';

/**
 * The three states a connector shows, everywhere it shows one (the list card,
 * the connector header, the app page): Connected, Needs account, Error. A
 * sign-in still to finish and a missing credential are both "Needs account":
 * adding or signing in an account is the fix in either case.
 */
export type ConnectorStatusTone = 'connected' | 'account' | 'error';

export const STATUS_DOT: Record<ConnectorStatusTone, string> = {
  connected: 'bg-kortix-green',
  account: 'bg-kortix-orange',
  error: 'bg-kortix-red',
};

/** The `connectorPages` key of each state's word. */
export const STATUS_WORD = {
  connected: 'statusConnected',
  account: 'statusNeedsAccount',
  error: 'statusError',
} as const;

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

/** What the connector runs over: its provider, named the way a person says it. */
export function connectorRunsOver(provider: AdminConnector['provider']): string {
  if (provider === 'composio') return 'Composio';
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'openapi') return 'OpenAPI';
  if (provider === 'graphql') return 'GraphQL';
  return providerLabel(provider);
}
