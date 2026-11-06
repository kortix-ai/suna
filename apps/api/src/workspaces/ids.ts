/**
 * Workspace identity types (design.md §0, §3 item 1).
 *
 * A workspace is ONE account and its ONE active project. It has two physical
 * keys, and they are never equal:
 *
 *   - `WorkspaceId` is the public id: the `project_id`. Every route, SDK call,
 *     URL and `KORTIX_PROJECT_ID` carries it.
 *   - `WorkspaceAccountKey` is the internal billing and directory key: the
 *     `account_id`. Credits, Stripe, members, roles and tokens key on it.
 *
 * Both are branded strings, so the compiler refuses one where the other is
 * expected. The brands exist only at compile time; at runtime both are uuid
 * strings. Convert at the seam (a route param, a DB row) with the `as*`
 * helpers below, never with a bare `as` cast.
 */

import { isUuid as isUuidShape } from '../shared/validate';

declare const workspaceIdBrand: unique symbol;
declare const workspaceAccountKeyBrand: unique symbol;

/** The public workspace id. Physically `kortix.projects.project_id`. */
export type WorkspaceId = string & { readonly [workspaceIdBrand]: 'WorkspaceId' };

/** The workspace's internal account key. Physically `kortix.accounts.account_id`. */
export type WorkspaceAccountKey = string & { readonly [workspaceAccountKeyBrand]: 'WorkspaceAccountKey' };

/** True when `value` is a uuid string (any version). Both workspace keys are uuids. */
export function isUuid(value: unknown): value is string {
  return isUuidShape(value);
}

/** Brand a `project_id` as a `WorkspaceId`. Throws `TypeError` on a non-uuid. */
export function asWorkspaceId(projectId: string): WorkspaceId {
  if (!isUuid(projectId)) throw new TypeError(`Not a workspace id: ${JSON.stringify(projectId)}`);
  return projectId.toLowerCase() as WorkspaceId;
}

/** Brand an `account_id` as a `WorkspaceAccountKey`. Throws `TypeError` on a non-uuid. */
export function asWorkspaceAccountKey(accountId: string): WorkspaceAccountKey {
  if (!isUuid(accountId)) throw new TypeError(`Not a workspace account key: ${JSON.stringify(accountId)}`);
  return accountId.toLowerCase() as WorkspaceAccountKey;
}
