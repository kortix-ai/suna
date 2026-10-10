import type { AdminConnector } from '@kortix/sdk';

import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';

import { providerLabel } from '../provider-label';

/** The four states a connector shows as a dot + word, on both detail pages. */
export type ConnectorStatusTone = 'working' | 'pending' | 'error' | 'setup';

export const STATUS_DOT: Record<ConnectorStatusTone, string> = {
  working: 'bg-kortix-green',
  pending: 'bg-kortix-blue',
  error: 'bg-kortix-red',
  setup: 'bg-kortix-orange',
};

/** The `connectorPages` key of each state's word. */
export const STATUS_WORD = {
  working: 'statusWorking',
  pending: 'statusPending',
  error: 'statusError',
  setup: 'statusNeedsSetup',
} as const;

export function connectorStatusTone(
  connector: Pick<AdminConnector, 'authorizationStrategy' | 'authSecret' | 'secretSet' | 'status'> &
    Partial<Pick<AdminConnector, 'provider' | 'lastError'>>,
): ConnectorStatusTone {
  const status = connectorSetupStatus(connector);
  if (status === 'pending') return 'pending';
  return status === 'error' ? 'error' : status === 'needs_setup' ? 'setup' : 'working';
}

/** What the connector runs over: its provider, named the way a person says it. */
export function connectorRunsOver(provider: AdminConnector['provider']): string {
  if (provider === 'composio') return 'Composio';
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'openapi') return 'OpenAPI';
  if (provider === 'graphql') return 'GraphQL';
  return providerLabel(provider);
}
