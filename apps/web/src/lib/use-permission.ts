'use client';

/**
 * The client-side authorization probe — **the only one**. Gates ask the engine
 * for the LEAF a route asserts (`project.gitops.push`, `member.update`), never
 * for a role label: a member holding a custom role that grants
 * `project.members.manage` is invisible to `effective_project_role === 'manager'`,
 * and that gap is exactly what the canonical model deletes.
 *
 * The implementation lives in `@kortix/sdk/react` (`use-can.ts`). This module is
 * the host binding: it injects the logged-in user from the web auth provider so
 * the SDK does not have to know about it, and re-exports the legacy hook names
 * the app already calls.
 *
 * NOT a security boundary — the API re-checks every mutating route. This decides
 * what to show and enable.
 *
 * **Cache contract.** A verdict is cached 5 minutes. Every write that changes an
 * assignment MUST call `invalidatePermissionProbes` — see `access-dialog.tsx`.
 */

import { useAuth } from '@/features/providers/auth-provider';
import type { PermissionProbeInput, PermissionProbeTarget } from '@/lib/iam-client';
import {
  useCan as useSdkCan,
  useCans as useSdkCans,
  usePermissionsFor as useSdkPermissionsFor,
  invalidatePermissionProbes,
  type CanResult,
  type CanTarget,
} from '@kortix/sdk/react';

export type { CanResult, CanTarget };
export { invalidatePermissionProbes };

/** @deprecated Name kept for the existing call sites. Use `CanResult`. */
export type UsePermissionResult = CanResult;
export type UsePermissionTarget = PermissionProbeTarget;

/** Can the CURRENT user perform `action` on this target?
 *  `{ accountId }` for an account action, `{ projectId }` for a project one. */
export function useCan(target: CanTarget, action: string): CanResult {
  const { user } = useAuth();
  return useSdkCan(target, action, { userId: user?.id });
}

/** Batch variant — ONE roundtrip, answers keyed by action. `actions` must be
 *  stable across renders (module-level or memoized). */
export function useCans(target: CanTarget, actions: readonly string[]): Record<string, CanResult> {
  const { user } = useAuth();
  return useSdkCans(target, actions, { userId: user?.id });
}

/** Account-scoped single probe. Thin alias of `useCan({ accountId }, action)`. */
export function usePermission(
  accountId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): CanResult {
  const { user } = useAuth();
  const resource =
    target && target.resourceType !== 'account'
      ? { type: target.resourceType, id: target.resourceId as string }
      : undefined;
  return useSdkCan({ accountId, resource }, action, { userId: user?.id });
}

/** Probe on behalf of ANOTHER member — "what can this person actually do".
 *  Caller needs `member.read`; the server enforces it. */
export function usePermissionFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): CanResult {
  const resource =
    target && target.resourceType !== 'account'
      ? { type: target.resourceType, id: target.resourceId as string }
      : undefined;
  return useSdkCan({ accountId, resource }, action, { userId: memberUserId });
}

/** Batch probe for another member. Answers come back in input order. */
export function usePermissionsFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  probes: PermissionProbeInput[],
): CanResult[] {
  return useSdkPermissionsFor(accountId, memberUserId, probes);
}

/** Current-user batch probe, probe-shaped. Prefer `useCans` for a single target. */
export function usePermissions(
  accountId: string | undefined,
  probes: PermissionProbeInput[],
): CanResult[] {
  const { user } = useAuth();
  return useSdkPermissionsFor(accountId, user?.id, probes);
}
