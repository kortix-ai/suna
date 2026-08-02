import type { AdminConnector } from '@kortix/sdk';

export type ConnectorRung = 'overview' | 'accounts' | 'permissions' | 'settings';

/**
 * The rung order NEVER changes. The old detail panel
 * (`connectors-view.tsx:1258`) computed `showConnections`, `showProfileTab`,
 * `showPermissions` and `showRoster` from provider, authorization strategy and
 * permission, so its tab bar rendered anywhere from zero to four tabs and the
 * surface reshaped per connector — no mental model ever formed. Here a rung
 * that does not apply is absent, but the ones that remain keep their positions.
 */
export const CONNECTOR_RUNG_ORDER: readonly ConnectorRung[] = [
  'overview',
  'accounts',
  'permissions',
  'settings',
];

export const CONNECTOR_RUNG_LABEL: Record<ConnectorRung, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  permissions: 'Permissions',
  settings: 'Settings',
};

/**
 * Which rungs a connector shows, in canonical order.
 *
 * - `overview` is unconditional: it is where a connector says what it is and
 *   what connecting it would mean, which is true even for a viewer who may
 *   change nothing.
 * - `accounts` and `settings` are dropped for `computer` connectors. A machine
 *   is paired, granted per-capability and audited in the Computers tab; the
 *   generic credential/remove surface would be a second, wrong control for the
 *   same thing. Overview links there instead (capability #13).
 * - `permissions` and `settings` are writer-only — both mutate project state.
 *   `accounts` stays for a read-only viewer because it is also how they see
 *   whether the connector is usable, and how they connect their OWN account.
 */
export function visibleRungs(
  connector: AdminConnector,
  caps: { canWrite: boolean },
): ConnectorRung[] {
  const isComputer = connector.provider === 'computer';
  const present = new Set<ConnectorRung>(['overview']);
  if (!isComputer) present.add('accounts');
  if (caps.canWrite) present.add('permissions');
  if (caps.canWrite && !isComputer) present.add('settings');
  return CONNECTOR_RUNG_ORDER.filter((rung) => present.has(rung));
}
