'use client';

/**
 * The client-side authorization probe — **the only one**. Gates ask the engine
 * for the LEAF a route asserts (`project.gitops.push`, `member.update`), never
 * for a role label: a member holding a custom role that grants
 * `project.members.manage` is invisible to `effective_project_role === 'manager'`,
 * and that gap is exactly what the canonical model deletes.
 *
 * The implementation lives in `@kortix/sdk/react` (`use-can.ts`). This module is
 * the host binding: it injects the viewer from `useUiViewerId` so
 * the SDK does not have to know about it, and re-exports the legacy hook names
 * the app already calls.
 *
 * NOT a security boundary — the API re-checks every mutating route. This decides
 * what to show and enable.
 *
 * **Cache contract.** A verdict is cached 5 minutes. Every write that changes an
 * assignment MUST call `invalidatePermissionProbes` — see `access-dialog.tsx`.
 */

import { useUiHostConfig, useUiViewerId } from '../../providers/ui-provider';
import type { PermissionProbeInput, PermissionProbeTarget } from '@kortix/sdk';
import {
  invalidatePermissionProbes,
  useCan as useSdkCan,
  useCans as useSdkCans,
  usePermissionsFor as useSdkPermissionsFor,
  type CanResult,
  type CanTarget,
} from '@kortix/sdk/react';

export { invalidatePermissionProbes };
export type { CanResult, CanTarget };

/** @deprecated Name kept for the existing call sites. Use `CanResult`. */
export type UsePermissionResult = CanResult;
export type UsePermissionTarget = PermissionProbeTarget;

/** The verdict when the host serves no IAM probes (`accountApiEnabled: false`):
 *  show the control, and the server enforces the route. */
const HOST_ENFORCED: CanResult = { allowed: true, reason: 'host_enforced', isLoading: false, isError: false };
/** A target the SDK never resolves, so its probe query stays disabled. */
const NO_TARGET: CanTarget = { accountId: undefined };

function useProbesEnabled(): boolean {
  return useUiHostConfig().accountApiEnabled;
}

/** Can the CURRENT user perform `action` on this target?
 *  `{ accountId }` for an account action, `{ projectId }` for a project one. */
export function useCan(target: CanTarget, action: string): CanResult {
  const userId = useUiViewerId();
  const probes = useProbesEnabled();
  const result = useSdkCan(probes ? target : NO_TARGET, action, { userId });
  return probes ? result : HOST_ENFORCED;
}

/** Batch variant — ONE roundtrip, answers keyed by action. `actions` must be
 *  stable across renders (module-level or memoized). */
export function useCans(target: CanTarget, actions: readonly string[]): Record<string, CanResult> {
  const userId = useUiViewerId();
  const probes = useProbesEnabled();
  const result = useSdkCans(probes ? target : NO_TARGET, actions, { userId });
  return probes ? result : Object.fromEntries(actions.map((action) => [action, HOST_ENFORCED]));
}

/** Account-scoped single probe. Thin alias of `useCan({ accountId }, action)`. */
export function usePermission(
  accountId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): CanResult {
  const userId = useUiViewerId();
  const probes = useProbesEnabled();
  const resource =
    target && target.resourceType !== 'account'
      ? { type: target.resourceType, id: target.resourceId as string }
      : undefined;
  const result = useSdkCan(probes ? { accountId, resource } : NO_TARGET, action, { userId });
  return probes ? result : HOST_ENFORCED;
}

/** Probe on behalf of ANOTHER member — "what can this person actually do".
 *  Caller needs `member.read`; the server enforces it. */
export function usePermissionFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): CanResult {
  const probes = useProbesEnabled();
  const resource =
    target && target.resourceType !== 'account'
      ? { type: target.resourceType, id: target.resourceId as string }
      : undefined;
  const result = useSdkCan(probes ? { accountId, resource } : NO_TARGET, action, { userId: memberUserId });
  return probes ? result : HOST_ENFORCED;
}

/** Batch probe for another member. Answers come back in input order. */
export function usePermissionsFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  probes: PermissionProbeInput[],
): CanResult[] {
  const enabled = useProbesEnabled();
  const result = useSdkPermissionsFor(enabled ? accountId : undefined, memberUserId, probes);
  return enabled ? result : probes.map(() => HOST_ENFORCED);
}

/** Current-user batch probe, probe-shaped. Prefer `useCans` for a single target. */
export function usePermissions(
  accountId: string | undefined,
  probes: PermissionProbeInput[],
): CanResult[] {
  const userId = useUiViewerId();
  const enabled = useProbesEnabled();
  const result = useSdkPermissionsFor(enabled ? accountId : undefined, userId, probes);
  return enabled ? result : probes.map(() => HOST_ENFORCED);
}
