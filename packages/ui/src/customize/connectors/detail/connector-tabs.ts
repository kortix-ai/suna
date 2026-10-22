import type { AdminConnector } from '@kortix/sdk';

export type ConnectorTab = 'accounts' | 'tools' | 'triggers' | 'settings';

/**
 * Tab order never changes. A tab that does not apply is absent; the ones that
 * remain keep their positions, so the surface does not reshape per connector.
 */
export const CONNECTOR_TABS: readonly ConnectorTab[] = ['accounts', 'tools', 'triggers', 'settings'];

/** `hardcodedUi.i18nComplete` key of each tab's label. */
export const CONNECTOR_TAB_LABEL_KEY: Record<ConnectorTab, string> = {
  accounts: 'text8a7c8b67fe8b',
  tools: 'textea93d6a262ec',
  triggers: 'texte62f2148a64d',
  settings: 'text74a883a037bc',
};

/**
 * Which tabs a connector shows.
 *
 * - The name, icon, status and connect action live in the modal header, above
 *   every tab — so there is no separate Overview tab.
 * - Every connector has Accounts. For the computer connector, each account is
 *   one paired machine.
 * - Tools and Settings mutate project state, so they are writer-only. Accounts
 *   stays for readers: it is how they see whether the connector works, and how
 *   they connect their own account.
 * - Triggers lists the app event triggers on this connector. It shows only when
 *   the connector's app has events (`hasEvents`), and for readers too: it is a
 *   list, and its New button is gated on its own permission.
 * - The computer connector is built in: nothing to configure and it cannot be
 *   removed, so it has no Settings.
 */
export function connectorTabs(
  connector: AdminConnector,
  caps: { canWrite: boolean; hasEvents?: boolean },
): ConnectorTab[] {
  const present = new Set<ConnectorTab>();
  present.add('accounts');
  if (caps.canWrite) present.add('tools');
  if (caps.hasEvents) present.add('triggers');
  if (caps.canWrite && connector.provider !== 'computer') present.add('settings');
  return CONNECTOR_TABS.filter((tab) => present.has(tab));
}
