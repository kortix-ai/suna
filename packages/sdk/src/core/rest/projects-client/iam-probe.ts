import { ApiError, backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { EffectivePermissionProbe, ResourceType } from './iam-types';

// ─── Effective permissions probe ───────────────────────────────────────────

/** The server rejects batches above this (BATCH_MAX,
 *  apps/api/src/accounts/iam/members.ts). Mirrored here because the SDK ships
 *  standalone; a larger coalesced bucket is chunked, never rejected. */
const CLIENT_BATCH_MAX = 64;

/** One waiter per CALL — identical probes share the answer, not the waiter. */
type PendingProbe = {
  input: PermissionProbeInput;
  resolve: (result: PermissionProbeResult) => void;
  reject: (error: unknown) => void;
};

/** Full authorization context: probes never merge across accounts or users. */
const probeContext = (accountId: string, userId: string): string => `${accountId}\n${userId}`;

/** Dedupe identity within a bucket: identical (action, target) pairs send one
 *  entry and every caller gets its own copy of the answer. */
const probeIdentity = (probe: PermissionProbeInput): string =>
  JSON.stringify([probe.action, probe.resourceType ?? null, probe.resourceId ?? null]);

/** Probes waiting to flush, per context, deduped by identity. */
const pendingBuckets = new Map<string, Map<string, PendingProbe[]>>();

function flushBucket(accountId: string, userId: string, context: string): void {
  const bucket = pendingBuckets.get(context);
  pendingBuckets.delete(context);
  if (!bucket || bucket.size === 0) return;

  const identities = [...bucket.keys()];
  for (let offset = 0; offset < identities.length; offset += CLIENT_BATCH_MAX) {
    const chunk: Array<{ identity: string; waiters: PendingProbe[]; input: PermissionProbeInput }> =
      [];
    for (const identity of identities.slice(offset, offset + CLIENT_BATCH_MAX)) {
      const waiters = bucket.get(identity);
      const input = waiters?.[0]?.input;
      if (waiters && input) chunk.push({ identity, waiters, input });
    }
    // showErrors: false keeps the old single-GET parity (iamGet's silent
    // background read): a failed background probe fails closed in the caller
    // without a global toast or a Sentry capture.
    probeEffectivePermissions(
      accountId,
      userId,
      chunk.map((entry) => entry.input),
      { showErrors: false },
    )
      .then((results) => {
        chunk.forEach(({ identity, waiters }, i) => {
          const answer = results[i];
          if (!answer) {
            waiters.forEach((w) =>
              w.reject(new Error(`effective:batch returned no answer for ${identity}`)),
            );
            return;
          }
          waiters.forEach((w) => w.resolve(answer));
        });
      })
      .catch((error) => {
        // The batch route validates every probe first and 400s the WHOLE batch
        // when one is invalid (members.ts) — the single GET answered each probe
        // alone, and even answers an unknown resourceType. Ask each entry again
        // alone so every waiter gets the verdict or error it got before
        // coalescing (KRTX-4042). Any other failure (auth, 5xx, network) does
        // not depend on the batch's content: fail every waiter closed, no fan-out.
        if (!(error instanceof ApiError && error.status === 400)) {
          chunk.forEach(({ waiters }) => waiters.forEach((w) => w.reject(error)));
          return;
        }
        chunk.forEach(({ waiters, input }) => {
          probeAlone(accountId, userId, input).then(
            (answer) => waiters.forEach((w) => w.resolve(answer)),
            (singleError) => waiters.forEach((w) => w.reject(singleError)),
          );
        });
      });
  }
}

/** One probe on the single GET route — the fallback for a batch rejected for
 *  its content. iamGet reads with showErrors:false, like the coalesced POST. */
async function probeAlone(
  accountId: string,
  userId: string,
  args: PermissionProbeInput,
): Promise<PermissionProbeResult> {
  const params = new URLSearchParams();
  params.set('action', args.action);
  if (args.resourceType) params.set('resourceType', args.resourceType);
  if (args.resourceId) params.set('resourceId', args.resourceId);
  const answer = unwrap(
    await iamGet<EffectivePermissionProbe>(
      `/accounts/${accountId}/iam/members/${userId}/effective?${params.toString()}`,
    ),
  );
  // The single route omits resource_id. The batch route reports the target id
  // of a project probe and null for every other target (probeObject, members.ts).
  return { ...answer, resource_id: args.resourceType === 'project' ? args.resourceId : null };
}

/**
 * Single effective-permission probe. Concurrent calls for one (account, user)
 * — the full authorization context — coalesce into ONE `effective:batch` POST:
 * a page mounting several gates at once fired one GET per gate, and production
 * logged 7-8 successful GETs to the same /effective path within a single
 * second (KRTX-4005). The batch endpoint answers with identical auth semantics
 * (same member.read gate, same probeActor — apps/api/src/accounts/iam/members.ts).
 *
 * The coalescing window is one macrotask: probes issued in the same
 * synchronous burst share a request; a later probe starts a fresh bucket, so
 * there is no unbounded wait, no idle polling and no stale-allow window —
 * every caller still gets its own verdict. A batch the server rejects for its
 * content (400: one invalid probe) is asked again one probe at a time, so one
 * bad probe fails alone; any other batch error rejects every waiter of the
 * failed batch (fail closed upstream).
 */
export async function probeEffectivePermission(
  accountId: string,
  userId: string,
  args: PermissionProbeInput,
): Promise<PermissionProbeResult> {
  const context = probeContext(accountId, userId);
  let bucket = pendingBuckets.get(context);
  // A timer is pending exactly while a bucket exists: the first probe of a
  // fresh bucket schedules the flush, and flushBucket deletes the bucket up
  // front, so a probe arriving after that starts a fresh bucket + timer.
  const freshBucket = !bucket;
  if (!bucket) {
    bucket = new Map();
    pendingBuckets.set(context, bucket);
  }
  const identity = probeIdentity(args);
  const waiters = bucket.get(identity);
  const waiter: PendingProbe = {
    input: args,
    resolve: () => {},
    reject: () => {},
  };
  const settled = new Promise<PermissionProbeResult>((resolve, reject) => {
    waiter.resolve = resolve;
    waiter.reject = reject;
  });
  if (waiters) {
    waiters.push(waiter);
  } else {
    bucket.set(identity, [waiter]);
  }
  if (freshBucket) {
    setTimeout(() => flushBucket(accountId, userId, context), 0);
  }
  return settled;
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
  /** The same action's workspace name (`workspace.read` for `project.read`). Sent by API versions with Workspaces. */
  workspace_action?: string;
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
  options?: { showErrors?: boolean },
) {
  if (probes.length === 0) return [] as PermissionProbeResult[];
  return unwrap(
    await backendApi.post<{ results: PermissionProbeResult[] }>(
      `/accounts/${accountId}/iam/members/${userId}/effective:batch`,
      { probes },
      { showErrors: options?.showErrors ?? true },
    ),
  ).results;
}
