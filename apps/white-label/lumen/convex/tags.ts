// Plain module (no "use node"): the Convex actions and the Next.js proxy both
// tag sessions with it, so a thread carries the same ids whichever side created it.

/** The generic Kortix fields that carry Lumen's ids on a session (labels ≤ 64 chars). */
export function lumenSessionTags(a: { orgId: string; userId: string }, workspaceId: string) {
  return {
    labels: [`lumen-user:${a.userId}`.slice(0, 64), `lumen-workspace:${workspaceId}`.slice(0, 64)],
    metadata: { lumen_org_id: a.orgId, lumen_workspace_id: workspaceId, lumen_user_id: a.userId },
  };
}

const isLumenLabel = (l: string) => l.toLowerCase().startsWith("lumen-");
const isLumenKey = (k: string) => k.toLowerCase().startsWith("lumen_");

/** The client's labels without the `lumen-` namespace. */
function clientLabels(labels: unknown): string[] {
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string" && !isLumenLabel(l)) : [];
}

/** The client's metadata without the `lumen_` keys (a null value would delete one). */
function clientMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).filter(([k]) => !isLumenKey(k)));
}

/** Lumen's labels first, so 20 client labels (Kortix's limit) cannot push them out. */
const mergeLabels = (lumen: string[], client: string[]) => [...new Set([...lumen, ...client])].slice(0, 20);

/**
 * The body of a session create, with Lumen's tags applied. A client label in
 * the `lumen-` namespace or a `lumen_` metadata key is dropped, so a member
 * cannot attribute a session to another user or workspace.
 */
export function tagSessionCreate(
  body: Record<string, unknown>,
  a: { orgId: string; userId: string },
  workspaceId: string,
): Record<string, unknown> & { labels: string[]; metadata: Record<string, unknown> } {
  const tags = lumenSessionTags(a, workspaceId);
  return {
    ...body,
    labels: mergeLabels(tags.labels, clientLabels(body.labels)),
    metadata: { ...clientMetadata(body.metadata), ...tags.metadata },
  };
}

/**
 * The body of a session PATCH, with Lumen's tags kept. Kortix replaces
 * `labels` and merges `metadata` (a null value deletes a key). So the session's
 * current `lumen-` labels stay first in any new label list, and client
 * `lumen_` metadata keys are dropped: a member can neither forge nor erase
 * the attribution set at create time.
 */
export function tagSessionPatch(body: Record<string, unknown>, currentLabels: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if ("labels" in body) out.labels = mergeLabels(currentLabels.filter(isLumenLabel), clientLabels(body.labels));
  if ("metadata" in body) out.metadata = clientMetadata(body.metadata);
  return out;
}
