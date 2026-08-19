'use client';

/**
 * Project-scoped capability gating. The implementation is `useCan` /`useCans`
 * in `@kortix/sdk/react`; this module keeps the two legacy names the app already
 * calls, bound to the web auth provider.
 *
 * `useCan({ projectId }, action)` is the canonical spelling. It resolves the
 * owning account from the shared project cache, so callers pass only a project
 * id; pass `accountId` when you already hold it and the probe fires on the first
 * render instead of after a second fetch.
 */

import type { PermissionProbeInput, PermissionProbeTarget } from '@/lib/iam-client';
import { useCan, useCans, type CanResult } from '@/lib/use-permission';

export type { CanResult };

/** The probe target for one project. Exported for callers that build a probe
 *  list by hand (the member-capability panels). */
export function projectPermissionTarget(
  projectId: string | undefined,
): Extract<PermissionProbeTarget, { resourceType: 'project' }> | undefined {
  if (!projectId) return undefined;
  return { resourceType: 'project', resourceId: projectId };
}

/** N actions against one project, as a probe list. */
export function projectPermissionProbes(
  projectId: string | undefined,
  actions: readonly string[],
): PermissionProbeInput[] {
  const target = projectPermissionTarget(projectId);
  return target ? actions.map((action) => ({ action, ...target })) : [];
}

/** Can the current user perform `action` on this project? */
export function useProjectCan(
  projectId: string | undefined,
  action: string,
  options?: { accountId?: string },
): CanResult {
  return useCan({ projectId, accountId: options?.accountId }, action);
}

/** Batch variant — one roundtrip, answers keyed by action. `actions` must be
 *  stable across renders. */
export function useProjectCans(
  projectId: string | undefined,
  actions: readonly string[],
  options?: { accountId?: string },
): Record<string, CanResult> {
  return useCans({ projectId, accountId: options?.accountId }, actions);
}
