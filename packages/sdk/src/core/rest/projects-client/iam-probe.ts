import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { ResourceType, EffectivePermissionProbe } from './iam-types';

// ─── Effective permissions probe ───────────────────────────────────────────

export async function probeEffectivePermission(
  accountId: string,
  userId: string,
  args: PermissionProbeInput,
) {
  const params = new URLSearchParams();
  params.set('action', args.action);
  if (args.resourceType) params.set('resourceType', args.resourceType);
  if (args.resourceId) params.set('resourceId', args.resourceId);
  return unwrap(
    await iamGet<EffectivePermissionProbe>(
      `/accounts/${accountId}/iam/members/${userId}/effective?${params.toString()}`,
    ),
  );
}

type NonAccountPermissionProbeTarget = {
  [Type in Exclude<ResourceType, 'account'>]: {
    resourceType: Type;
    resourceId: string;
  };
}[Exclude<ResourceType, 'account'>];

export type PermissionProbeTarget =
  | { resourceType: 'account'; resourceId?: never }
  | NonAccountPermissionProbeTarget;

export type PermissionProbeInput = { action: string } & (
  | { resourceType?: never; resourceId?: never }
  | PermissionProbeTarget
);

export interface PermissionProbeResult {
  action: string;
  resource_type: ResourceType;
  resource_id: string | null;
  allowed: boolean;
  reason: string | null;
}

/**
 * Batch variant — answers come back in the same order as the input. Use this
 * when a single render needs more than ~3 probes (capabilities panel,
 * multi-button gating on the same page). The server dedupes duplicate
 * (action, target) pairs internally.
 */
export async function probeEffectivePermissions(
  accountId: string,
  userId: string,
  probes: PermissionProbeInput[],
) {
  if (probes.length === 0) return [] as PermissionProbeResult[];
  return unwrap(
    await backendApi.post<{ results: PermissionProbeResult[] }>(
      `/accounts/${accountId}/iam/members/${userId}/effective:batch`,
      { probes },
    ),
  ).results;
}
