import { appendQuery } from './iam-query';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { ResourceGrantType } from './access';

// ─── Resource grants (account-wide) ────────────────────────────────────────
// The account-scoped counterpart of `listProjectResourceGrants` (./access.ts)
// — same underlying rows (a resource grant is still a project-scoped record),
// but this LISTS across every project in one call instead of one project at
// a time, for the account-level "which agents can this member/group reach,
// everywhere" surface. Mutating a grant still goes through the project-scoped
// `createProjectResourceGrant` / `deleteProjectResourceGrant` — there is no
// account-wide write, only an account-wide read.
export interface AccountResourceGrant {
  grant_id: string;
  project_id: string;
  project_name: string;
  resource_type: ResourceGrantType;
  resource_id: string;
  principal_type: 'member' | 'group';
  principal_id: string;
  /** Resolved label — member email or group name. */
  principal_label: string;
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface ListAccountResourceGrantsFilter {
  resourceType?: ResourceGrantType;
  principalType?: 'member' | 'group';
  principalId?: string;
  projectId?: string;
}

export async function listAccountResourceGrants(
  accountId: string,
  filter: ListAccountResourceGrantsFilter = {},
) {
  const query = appendQuery({ resourceType: filter.resourceType, principalType: filter.principalType, principalId: filter.principalId, projectId: filter.projectId });
  return unwrap(
    await iamGet<{ grants: AccountResourceGrant[] }>(
      `/accounts/${accountId}/iam/resource-grants${query}`,
    ),
  ).grants;
}
