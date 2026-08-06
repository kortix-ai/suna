import type { AdminConnector } from '@kortix/sdk';

export type ConnectorTab = 'accounts' | 'tools' | 'settings';

/**
 * Tab order never changes. A tab that does not apply is absent; the ones that
 * remain keep their positions, so the surface does not reshape per connector.
 */
export const CONNECTOR_TABS: readonly ConnectorTab[] = ['accounts', 'tools', 'settings'];

export const CONNECTOR_TAB_LABEL: Record<ConnectorTab, string> = {
  accounts: 'Accounts',
  tools: 'Tools',
  settings: 'Settings',
};

/**
 * Which tabs a connector shows.
 *
 * - The name, icon, status and connect action live in the modal header, above
 *   every tab — so there is no separate Overview tab.
 * - `computer` connectors are paired and audited in Computers, so they get
 *   neither Accounts nor Settings; the generic credential and remove controls
 *   would be a second, wrong way to do the same thing.
 * - Tools and Settings mutate project state, so they are writer-only. Accounts
 *   stays for readers: it is how they see whether the connector works, and how
 *   they connect their own account.
 */
export function connectorTabs(
  connector: AdminConnector,
  caps: { canWrite: boolean },
): ConnectorTab[] {
  const isComputer = connector.provider === 'computer';
  const present = new Set<ConnectorTab>();
  if (!isComputer) present.add('accounts');
  if (caps.canWrite) present.add('tools');
  if (caps.canWrite && !isComputer) present.add('settings');
  return CONNECTOR_TABS.filter((tab) => present.has(tab));
}
