import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { ResourceType, IamRole } from './iam-types';

// ─── Roles ─────────────────────────────────────────────────────────────────

export async function listRoles(accountId: string) {
  return unwrap(await iamGet<{ roles: IamRole[] }>(`/workspaces/${accountId}/iam/roles`)).roles;
}

/** Auto-provisioned agent (service-account) identities — the principal picker for
 *  binding a role to an agent, promoting it to a standing teammate. */
export interface AgentIdentity {
  service_account_id: string;
  name: string;
  project_id: string | null;
  agent_name: string | null;
}

export async function listAgentIdentities(accountId: string) {
  return unwrap(
    await iamGet<{ agents: AgentIdentity[] }>(`/workspaces/${accountId}/iam/agent-identities`),
  ).agents;
}

/** One project's agent identities, readable by any project member — the
 *  principals a "Who can use it" picker offers for a secret value or a
 *  connector account. `listAgentIdentities` spans the account and needs
 *  `policy.read`. */
export async function listProjectAgentIdentities(projectId: string) {
  return unwrap(
    await backendApi.get<{ agents: AgentIdentity[] }>(`/workspaces/${projectId}/agent-identities`, {
      showErrors: false,
    }),
  ).agents;
}

export async function getRolePermissions(accountId: string, roleId: string) {
  return unwrap(
    await iamGet<{ role_id: string; key: string; actions: string[] }>(
      `/workspaces/${accountId}/iam/roles/${roleId}/permissions`,
    ),
  );
}

export interface ActionCatalogEntry {
  action: string;
  label: string;
  resource_type: ResourceType;
}

export async function listActions(accountId: string) {
  return unwrap(
    await iamGet<{ actions: ActionCatalogEntry[] }>(`/workspaces/${accountId}/iam/actions`),
  ).actions;
}

export async function getRoleUsage(accountId: string, roleId: string) {
  return unwrap(
    await iamGet<{ role_id: string; policy_count: number }>(
      `/workspaces/${accountId}/iam/roles/${roleId}/usage`,
    ),
  );
}

export async function createRole(
  accountId: string,
  input: {
    key: string;
    name: string;
    description?: string;
    resourceType: ResourceType;
    actions: string[];
  },
) {
  return unwrap(
    await backendApi.post<IamRole>(`/workspaces/${accountId}/iam/roles`, input, {
      showErrors: false,
    }),
  );
}

export async function updateRole(
  accountId: string,
  roleId: string,
  patch: { name?: string; description?: string | null },
) {
  return unwrap(
    await backendApi.patch<IamRole>(`/workspaces/${accountId}/iam/roles/${roleId}`, patch, {
      showErrors: false,
    }),
  );
}

export async function updateRolePermissions(accountId: string, roleId: string, actions: string[]) {
  return unwrap(
    await backendApi.put<{ role_id: string; actions: string[] }>(
      `/workspaces/${accountId}/iam/roles/${roleId}/permissions`,
      { actions },
      { showErrors: false },
    ),
  );
}

export async function deleteRole(accountId: string, roleId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/workspaces/${accountId}/iam/roles/${roleId}`, {
      showErrors: false,
    }),
  );
}

// ─── Super-admin promotion ─────────────────────────────────────────────────

export async function setMemberSuperAdmin(
  accountId: string,
  userId: string,
  isSuperAdmin: boolean,
) {
  return unwrap(
    await backendApi.patch<{ user_id: string; is_super_admin: boolean }>(
      `/workspaces/${accountId}/iam/members/${userId}/super-admin`,
      { isSuperAdmin },
    ),
  );
}
