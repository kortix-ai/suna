// Connector policies — kortix.yaml-backed project-wide tool policies.

import { backendApi } from '../../http/api-client';
import type { ConnectorSyncResult } from './connectors';
import { unwrap } from './shared';

// ─── Connector policies (kortix.yaml-backed) ────────────────────────────────

export type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type PolicyDefaultMode = 'risk' | 'allow_all';

/**
 * One condition on the ARGUMENTS of a call. A rule carrying conditions applies
 * only when its tool pattern matches AND every condition holds — which is how
 * "may send email, but only to these addresses" is expressed. A tool-name
 * pattern alone cannot say that.
 *
 * `arg` is a dot path into the call arguments (`to`, `message.channel`).
 * `match` uses the same grammar as `ProjectPolicy.match`: a glob by default, or
 * an explicit `/regex/flags` when slash-wrapped.
 */
export interface PolicyArgCondition {
  arg: string;
  match: string;
  /** Invert: the condition holds when the value does NOT match. */
  negate?: boolean;
}

export interface ProjectPolicy {
  match: string;
  action: PolicyAction;
  /** ALL must hold for the rule to apply. Absent/empty = a plain tool-name rule. */
  conditions?: PolicyArgCondition[] | null;
}

export interface ProjectPoliciesResponse {
  policies: ProjectPolicy[];
  defaultMode: PolicyDefaultMode;
  errors: Array<{ path: string; error: string }>;
}

export async function listProjectPolicies(workspaceId: string) {
  return unwrap(
    await backendApi.get<ProjectPoliciesResponse>(`/connectors/projects/${workspaceId}/policies`),
  );
}

export async function setProjectPolicies(
  workspaceId: string,
  policies: ProjectPolicy[],
  defaultMode: PolicyDefaultMode,
) {
  return unwrap(
    await backendApi.put<{ ok: boolean; sync?: ConnectorSyncResult }>(
      `/connectors/projects/${workspaceId}/policies`,
      { policies, defaultMode },
    ),
  );
}
