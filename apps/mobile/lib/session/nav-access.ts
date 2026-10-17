/**
 * Who sees which project navigation row. Mirrors web's `capabilityAccess`
 * (`project-settings-nav.tsx`): a row shows only when the IAM probe holds its
 * read leaf AND one of its write leaves, so a plain member never lands on a
 * read-only configuration page. Nothing shows before the verdict lands, and a
 * failed probe counts as denied. Pure: callers pass the `useCans` result.
 */

import { PROJECT_ACTIONS } from '@kortix/sdk';

const A = PROJECT_ACTIONS;

type Cans = Readonly<Record<string, { allowed: boolean; isLoading: boolean } | undefined>>;

/** The leaves a Customize row needs: its read leaf and one write leaf. */
export interface NavAccess {
  read: string;
  manage?: readonly string[];
}

export const SCHEDULES_ACCESS: NavAccess = {
  read: A.PROJECT_TRIGGER_READ,
  manage: [A.PROJECT_TRIGGER_CREATE, A.PROJECT_TRIGGER_UPDATE, A.PROJECT_TRIGGER_DELETE],
};
export const SECRETS_ACCESS: NavAccess = { read: A.PROJECT_SECRET_READ, manage: [A.PROJECT_SECRET_WRITE] };
export const MEMBERS_ACCESS: NavAccess = { read: A.PROJECT_MEMBERS_READ };
export const CONNECTORS_ACCESS: NavAccess = {
  read: A.PROJECT_CONNECTOR_READ,
  manage: [A.PROJECT_CONNECTOR_WRITE, A.PROJECT_CONNECTOR_CONNECTIONS_MANAGE],
};
export const REVIEW_ACCESS: NavAccess = { read: A.PROJECT_REVIEW_READ, manage: [A.PROJECT_REVIEW_ACT] };

const NAV_ACCESS = [SCHEDULES_ACCESS, SECRETS_ACCESS, MEMBERS_ACCESS, CONNECTORS_ACCESS, REVIEW_ACCESS];

/** Every leaf the navigation rows read: one `useCans` batch. */
export const NAV_ACTIONS: readonly string[] = [
  ...new Set([...NAV_ACCESS.flatMap((a) => [a.read, ...(a.manage ?? [])]), A.PROJECT_APP_DEPLOY]),
];

const settled = (cans: Cans, actions: readonly string[]) =>
  actions.every((action) => cans[action] && !cans[action]!.isLoading);
const allowed = (cans: Cans, action: string) => cans[action]?.allowed === true;

/** True once the verdict landed and the caller holds the read leaf and a write leaf. */
export function navAccessAllowed(cans: Cans, access: NavAccess): boolean {
  if (!settled(cans, [access.read, ...(access.manage ?? [])])) return false;
  return allowed(cans, access.read) && (!access.manage || access.manage.some((a) => allowed(cans, a)));
}

/**
 * Apps row (web's `useAppsRowVisible`): the caller can deploy an App, or the
 * project already has one. `appCount` is undefined while the list loads.
 */
export function appsRowVisible(cans: Cans, appCount: number | undefined): boolean {
  if (allowed(cans, A.PROJECT_APP_DEPLOY)) return true;
  if (!settled(cans, [A.PROJECT_APP_DEPLOY])) return false;
  return (appCount ?? 0) > 0;
}
