import type { AdminConnector } from '@kortix/sdk';

import {
  connectorSetupStatus,
  type ConnectorSetupStatus,
} from '@/features/workspace/customize/sections/connector-connection-form';

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
  const meta = `${count} ${count === 1 ? 'tool' : 'tools'} · ${providerLabel}`;
  const status = connectorSetupStatus(connector);
  switch (status) {
    case 'connected':
      return `Connected · ${meta}`;
    case 'needs_setup':
      return `Needs setup — connect an account · ${meta}`;
    case 'user_managed':
      return `Each member connects their own account · ${meta}`;
    case 'no_auth':
      return `Ready, no sign-in needed · ${meta}`;
    case 'error':
      return `Error — the connection is failing · ${meta}`;
  }
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
