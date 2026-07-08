// Executor policies — kortix.yaml-backed project-wide tool policies.

import { backendApi } from '../api-client';
import { unwrap } from './shared';
import type { ConnectorSyncResult } from './connectors';

// ─── Executor policies (kortix.yaml-backed) ────────────────────────────────

export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type PolicyDefaultMode = 'risk' | 'allow_all';

export interface ProjectPolicy {
  match: string;
  action: PolicyAction;
}

export interface ProjectPoliciesResponse {
  policies: ProjectPolicy[];
  defaultMode: PolicyDefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export async function listProjectPolicies(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectPoliciesResponse>(`/executor/projects/${projectId}/policies`),
  );
}

export async function setProjectPolicies(
  projectId: string,
  policies: ProjectPolicy[],
  defaultMode: PolicyDefaultMode,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/executor/projects/${projectId}/policies`,
      { policies, defaultMode },
    ),
  );
}
