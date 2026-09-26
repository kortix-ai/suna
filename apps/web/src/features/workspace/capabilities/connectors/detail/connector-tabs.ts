import type { AdminConnector } from '@kortix/sdk';

export type ConnectorTab = 'overview' | 'accounts' | 'tools' | 'settings';

/**
 * Tab order never changes. A tab that does not apply is absent; the ones that
 * remain keep their positions, so the surface does not reshape per connector.
 */
export const CONNECTOR_TABS: readonly ConnectorTab[] = [
  'overview',
  'accounts',
  'tools',
  'settings',
];

export const CONNECTOR_TAB_LABEL: Record<ConnectorTab, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  tools: 'Tools',
  settings: 'Settings',
};

/**
 * Which tabs a connector shows.
 *
 * - Overview leads for every connector, in every state (Jay, 2026-09-26:
 *   "it should always show the same"). Not connected, it holds the setup
 *   checklist; connected, the status strip and try-it prompts (R5).
 *   Channels and computers run their own flows and never get it.
 * - Every connector has Accounts. For a Computer Tunnel profile, Accounts edits its
 *   assigned machine set and links to the fleet-management surface.
 * - Tools and Settings mutate project state, so they are writer-only. Accounts
 *   stays for readers: it is how they see whether the connector works, and how
 *   they connect their own account.
 */
export function connectorTabs(
  connector: AdminConnector,
  caps: { canWrite: boolean },
): ConnectorTab[] {
  const present = new Set<ConnectorTab>();
  const ownFlow = connector.provider === 'channel' || connector.provider === 'computer';
  if (!ownFlow) present.add('overview');
  present.add('accounts');
  if (caps.canWrite) present.add('tools');
  if (caps.canWrite) present.add('settings');
  return CONNECTOR_TABS.filter((tab) => present.has(tab));
}
