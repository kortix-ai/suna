import type { AdminConnector } from '@kortix/sdk';

import {
  connectorSetupStatus,
  type ConnectorSetupStatus,
} from '@/features/workspace/customize/sections/connector-connection-form';

import { isManagedConnectorProvider } from './provider-label';

/**
 * The short, actionable status phrase — what to DO, not what the wire said.
 * "Needs sign-in" for managed/OAuth providers, "Needs a credential" for
 * secret-based ones (Jay, 2026-09-14: failure states must name the next
 * action, never the protocol).
 */
export function connectorStatusShort(connector: AdminConnector): string {
  const status = connectorSetupStatus(connector);
  const managed = isManagedConnectorProvider(connector.provider);
  switch (status) {
    case 'connected':
      // Credential satisfied but the first sync has not landed yet: the
      // honest state is "working on it", not a broken-looking "0 tools".
      return connector.actions.length === 0 ? 'Syncing…' : 'Connected';
    case 'needs_setup':
      return managed ? 'Needs sign-in' : 'Needs a credential';
    case 'user_managed':
      return 'Each member signs in';
    case 'no_auth':
      return connector.actions.length === 0 ? 'Syncing…' : 'Ready';
    case 'error':
      // The dominant real cause is missing/failed auth (e.g. MCP 401), and
      // the fix is the connect dialog either way.
      if (connector.authSecret && !connector.secretSet) return 'Needs a credential';
      return managed ? 'Needs sign-in' : 'Not working — check the connection';
  }
}

/**
 * The card's one-line description, in words a non-technical reader can act on.
 *
 * It replaces the bare `12 tools · MCP` meta line on the Connected grid. That
 * line answered a question nobody on that tab is asking ("what kind of
 * connector is this?") and skipped the one everybody is ("does it work, and
 * if not, what do I do?"). The status leads; the tool count and provider stay
 * as trailing meta so the search box still matches what the card shows —
 * `filterConnectors` receives this same string as `describe`.
 */
export function connectorStatusLine(connector: AdminConnector, providerLabel: string): string {
  const count = connector.actions.length;
  const meta =
    count > 0 ? `${count} ${count === 1 ? 'tool' : 'tools'} · ${providerLabel}` : providerLabel;
  return `${connectorStatusShort(connector)} · ${meta}`;
}

/**
 * Which `kortix-*` tint the status carries, for the detail page's status tile.
 * Colors follow the design-system state table: green = connected, orange =
 * needs attention, red = error, neutral otherwise.
 */
export type ConnectorStatusTone = 'ok' | 'attention' | 'error' | 'neutral';

export function connectorStatusTone(
  status: ConnectorSetupStatus,
): ConnectorStatusTone {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'needs_setup':
      return 'attention';
    case 'error':
      return 'error';
    case 'user_managed':
    case 'no_auth':
      return 'neutral';
  }
}

/**
 * The detail page's Connection panel statement — a full sentence for the
 * status the badge only names. This is the answer to "what state am I in",
 * written so the next click is obvious.
 */
export function connectorStatusStatement(
  connector: AdminConnector,
  displayName: string,
): string {
  const status = connectorSetupStatus(connector);
  switch (status) {
    case 'connected':
      return `Connected. Agents can use ${displayName} in sessions.`;
    case 'needs_setup':
      return `Not connected yet. Connect an account so agents can use ${displayName}.`;
    case 'user_managed':
      return `Each member connects their own ${displayName} account for their private sessions.`;
    case 'no_auth':
      return `${displayName} needs no sign-in. Agents can call it right away.`;
    case 'error':
      return `The ${displayName} connection is failing. Reconnect it or check the credential.`;
  }
}
