import type { AdminConnector } from '@kortix/sdk';

/** The connector states and their rules live in `@kortix/sdk`. */
export {
  connectorDerivedState,
  connectorStatusTone,
  connectorUsable,
  type ConnectorDerivedState,
  type ConnectorStatusTone,
} from '@kortix/sdk';

import { providerLabel } from '../provider-label';

export const STATUS_DOT: Record<'connected' | 'account' | 'error', string> = {
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

/** What the connector runs over: its provider, named the way a person says it. */
export function connectorRunsOver(provider: AdminConnector['provider']): string {
  if (provider === 'composio') return 'Composio';
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'openapi') return 'OpenAPI';
  if (provider === 'graphql') return 'GraphQL';
  return providerLabel(provider);
}
