'use client';

/**
 * `useCan` / `useCans` — the ONLY client-side authorization read.
 *
 * Relocated from `apps/web/src/lib/use-permission.ts` + `use-project-can.ts`.
 * They were host-local, so every other host (the whitelabel demo, mobile) had
 * no probe at all and fell back to reading a role literal off a row — which is
 * exactly the bug the canonical model deletes: a member holding a custom role
 * that grants `project.members.manage` is invisible to `role === 'manager'`.
 *
 * Ask for the LEAF the route asserts (`project.gitops.push`), never for a role.
 * The engine answers; the client renders the answer.
 *
 * NOT a security boundary — the API re-checks every mutating route. This only
 * decides what to show and enable.
 *
 * ### Cache contract
 *
 * A verdict is cached for 5 minutes. That is only safe because every
 * assignment write calls `invalidatePermissionProbes`, so a revoke is visible
 * on the next render rather than up to five minutes later. If you add a write
 * path that changes an assignment, it calls that function. No exceptions.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  getProject,
  probeEffectivePermission,
  probeEffectivePermissions,
  validateToken,
  type PermissionProbeInput,
  type ResourceType,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** A probe verdict. `allowed` is true only when the engine said so — loading
 *  and error both read false, so a gate defaults to hidden/disabled. */
export interface CanResult {
  allowed: boolean;
  /** The engine's reason, e.g. `super_admin`, `role`, `not_a_member`,
   *  `agent_scope_insufficient`. Drives "why can Alice do this?" tooltips. */
  reason: string | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * What the action is being asked about.
 *
 *  - `{ accountId }` — an account-scope action (`member.update`, `role.create`).
 *  - `{ accountId, resource }` — narrowed to one account object (a group, a member).
 *  - `{ projectId }` — a project-scope action. The owning account is resolved
 *    from the shared project cache; pass `accountId` when you already hold it
 *    and the probe runs on the FIRST render instead of after a second fetch.
 */
export type CanTarget =
  | {
      accountId: string | undefined;
      projectId?: undefined;
      resource?: { type: Exclude<ResourceType, 'account'>; id: string };
    }
  | { projectId: string | undefined; accountId?: string; resource?: undefined };

export interface CanOptions {
  /** Probe as this user instead of the caller. A host with its own auth
   *  context passes it here rather than making the SDK depend on that context;
   *  omitted, the SDK resolves the caller from `GET /accounts/me`. */
  userId?: string;
}

const PROBE_STALE_MS = 5 * 60_000;

/** The single-probe cache key. Kept as a flat literal (not under `qk`) because
 *  it predates that factory and both `apps/web` and its tests address it. */
export const permissionProbeKey = (
  accountId: string | undefined,
  userId: string | undefined,
  action: string,
  target?: { resourceType?: string; resourceId?: string },
) =>
  [
    'iam-permission',
    accountId,
    userId,
    action,
    target?.resourceType ?? null,
    target?.resourceId ?? null,
  ] as const;

/** The batch cache key. Keyed on the probe LIST so adding or removing a probe
 *  refetches; the signature is action+target per probe, never object identity,
 *  which React swaps every render. */
export const permissionProbeBatchKey = (
  accountId: string | undefined,
  userId: string | undefined,
  probes: readonly PermissionProbeInput[],
) =>
  [
    'iam-permission-batch',
    accountId,
    userId,
    probes.map((p) => `${p.action}|${p.resourceType ?? ''}|${p.resourceId ?? ''}`).join(','),
  ] as const;

/** Identity of the calling principal, for hosts that do not inject one. */
const identityKey = ['iam-identity', 'me'] as const;

function useProbeUserId(explicit: string | undefined): string | undefined {
  const query = useQuery({
    queryKey: identityKey,
    queryFn: async () => (await validateToken()).identity ?? null,
    enabled: !explicit,
    staleTime: Infinity,
  });
  return explicit ?? query.data?.user_id;
}

/**
 * Resolve the account that owns a project. A DISABLED react-query query reports
 * `isLoading === false` in v5, so callers must not read the unresolved window
 * as a denial — `pending()` below converts it to "still loading".
 */
function useOwningAccountId(
  projectId: string | undefined,
  accountIdHint: string | undefined,
): string | undefined {
  const { data } = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => getProject(projectId as string),
    enabled: !!projectId && !accountIdHint,
    ...contract('config'),
  });
  return projectId ? (accountIdHint ?? data?.account_id) : undefined;
}

const pending = (): CanResult => ({
  allowed: false,
  reason: null,
  isLoading: true,
  isError: false,
});

/** Everything a target resolves to: the account to ask, and the probe target. */
function useResolvedTarget(target: CanTarget) {
  const isProject = 'projectId' in target && target.projectId !== undefined;
  const projectId = 'projectId' in target ? target.projectId : undefined;
  const owningAccountId = useOwningAccountId(projectId, target.accountId);
  const accountId = isProject ? owningAccountId : target.accountId;
  const probeTarget: { resourceType?: string; resourceId?: string } | undefined = isProject
    ? { resourceType: 'project', resourceId: projectId as string }
    : target.resource
      ? { resourceType: target.resource.type, resourceId: target.resource.id }
      : undefined;
  return { accountId, probeTarget, resolved: !!accountId && (!isProject || !!projectId) };
}

/** Can this principal perform `action` on this target? */
export function useCan(target: CanTarget, action: string, options?: CanOptions): CanResult {
  const userId = useProbeUserId(options?.userId);
  const { accountId, probeTarget, resolved } = useResolvedTarget(target);
  const enabled = resolved && !!userId;

  const query = useQuery({
    queryKey: permissionProbeKey(accountId, userId, action, probeTarget),
    queryFn: () =>
      probeEffectivePermission(
        accountId as string,
        userId as string,
        (probeTarget ? { action, ...probeTarget } : { action }) as PermissionProbeInput,
      ),
    enabled,
    staleTime: PROBE_STALE_MS,
  });

  if (!enabled) return pending();
  return {
    allowed: query.data?.allowed === true,
    reason: query.data?.reason ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Batch variant — ONE roundtrip for N actions on the same target. Returns a map
 * keyed by action, so a caller reads `caps[ACTION].allowed`.
 *
 * `actions` must be stable across renders (module-level or memoized): the query
 * key is derived from the list.
 */
export function useCans(
  target: CanTarget,
  actions: readonly string[],
  options?: CanOptions,
): Record<string, CanResult> {
  const userId = useProbeUserId(options?.userId);
  const { accountId, probeTarget, resolved } = useResolvedTarget(target);
  const probes: PermissionProbeInput[] = actions.map(
    (action) => (probeTarget ? { action, ...probeTarget } : { action }) as PermissionProbeInput,
  );
  const enabled = resolved && !!userId && probes.length > 0;

  const query = useQuery({
    queryKey: permissionProbeBatchKey(accountId, userId, probes),
    queryFn: () => probeEffectivePermissions(accountId as string, userId as string, probes),
    enabled,
    staleTime: PROBE_STALE_MS,
  });

  const map: Record<string, CanResult> = {};
  actions.forEach((action, i) => {
    if (!enabled) {
      map[action] = pending();
      return;
    }
    const hit = query.data?.[i];
    map[action] = {
      allowed: hit?.allowed === true,
      reason: hit?.reason ?? null,
      isLoading: query.isLoading,
      isError: query.isError,
    };
  });
  return map;
}

/**
 * Probe on behalf of ANOTHER member — the "what can this person actually do"
 * admin panels. Returns one result per input, in order. The caller needs
 * `member.read` on the account; the server enforces it.
 *
 * Kept probe-shaped (not action-shaped like `useCans`) because these panels mix
 * account and project targets in one request.
 */
export function usePermissionsFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  probes: PermissionProbeInput[],
): CanResult[] {
  const enabled = !!accountId && !!memberUserId && probes.length > 0;
  const query = useQuery({
    queryKey: permissionProbeBatchKey(accountId, memberUserId, probes),
    queryFn: () =>
      probeEffectivePermissions(accountId as string, memberUserId as string, probes),
    enabled,
    staleTime: PROBE_STALE_MS,
  });

  return probes.map((_, i) => {
    if (!enabled) return pending();
    const hit = query.data?.[i];
    return {
      allowed: hit?.allowed === true,
      reason: hit?.reason ?? null,
      isLoading: query.isLoading,
      isError: query.isError,
    };
  });
}

/**
 * Bust the probe cache after an assignment write. **Every** write that creates,
 * changes or revokes an assignment calls this — a 5-minute stale window on an
 * authorization verdict is a revoke that has not happened yet.
 *
 * Scope it as tightly as you honestly can: an account+user pair when you know
 * whose access changed, the account when a group or a role definition changed
 * (that moves verdicts for principals you cannot enumerate client-side), and
 * everything only when you know nothing.
 */
export function invalidatePermissionProbes(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  scope: { accountId?: string; userId?: string },
): Promise<void> {
  const suffix = [scope.accountId, scope.userId].filter((s): s is string => !!s);
  queryClient.invalidateQueries({ queryKey: ['iam-permission', ...suffix] });
  queryClient.invalidateQueries({ queryKey: ['iam-permission-batch', ...suffix] });
  return Promise.resolve();
}
