import { appendQuery } from './iam-query';
import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { ResourceType, PolicyScopeType, PrincipalType, IamPolicyEffect, PolicyConditions, IamPolicy } from './iam-types';

// ─── Policies ──────────────────────────────────────────────────────────────

export interface ListPoliciesFilter {
  principalType?: PrincipalType;
  principalId?: string;
  scopeType?: ResourceType;
  scopeId?: string | null;
}

export async function listPolicies(accountId: string, filter: ListPoliciesFilter = {}) {
  const query = appendQuery({ principalType: filter.principalType, principalId: filter.principalId, scopeType: filter.scopeType, scopeId: filter.scopeId === null ? 'null' : filter.scopeId });
  return unwrap(
    await iamGet<{ policies: IamPolicy[] }>(
      `/accounts/${accountId}/iam/policies${query}`,
    ),
  ).policies;
}

export async function createPolicy(
  accountId: string,
  input: {
    principalType: PrincipalType;
    principalId: string;
    scopeType: PolicyScopeType;
    scopeId?: string | null;
    roleId: string;
    effect?: IamPolicyEffect;
    /** Optional gating conditions. Omit for an unconditional policy. */
    conditions?: PolicyConditions;
    /** Optional hard expiry (ISO-8601). Omit for permanent. */
    expires_at?: string | null;
  },
) {
  return unwrap(
    await backendApi.post<IamPolicy>(`/accounts/${accountId}/iam/policies`, input, {
      showErrors: false,
    }),
  );
}

export async function updatePolicy(
  accountId: string,
  policyId: string,
  input: {
    scopeType: PolicyScopeType;
    scopeId?: string | null;
    roleId: string;
    effect: IamPolicyEffect;
    /** Omit to leave existing conditions untouched. Pass `{}` to clear. */
    conditions?: PolicyConditions;
    /** Undefined = leave untouched; null = clear expiry; ISO = set. */
    expires_at?: string | null;
  },
) {
  return unwrap(
    await backendApi.patch<IamPolicy>(`/accounts/${accountId}/iam/policies/${policyId}`, input, {
      showErrors: false,
    }),
  );
}

export async function deletePolicy(accountId: string, policyId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(
      `/accounts/${accountId}/iam/policies/${policyId}`,
    ),
  );
}

export interface BulkDeleteResult {
  deleted: number;
}

export async function bulkDeletePolicies(accountId: string, policyIds: string[]) {
  return unwrap(
    await backendApi.post<BulkDeleteResult>(
      `/accounts/${accountId}/iam/policies:bulk-delete`,
      { policy_ids: policyIds },
      { showErrors: false },
    ),
  );
}

export interface BulkImportEntry {
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: PolicyScopeType;
  scope_id?: string | null;
  /** Reference by role key (not id) so exported JSON is portable
   *  across accounts. */
  role_key: string;
  effect?: IamPolicyEffect;
  conditions?: PolicyConditions;
  expires_at?: string | null;
}

export interface BulkImportResult {
  attempted: number;
  created: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
}

export async function bulkImportPolicies(accountId: string, policies: BulkImportEntry[]) {
  return unwrap(
    await backendApi.post<BulkImportResult>(
      `/accounts/${accountId}/iam/policies:bulk-import`,
      { policies },
      { showErrors: false },
    ),
  );
}
