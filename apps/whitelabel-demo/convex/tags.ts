// Plain module (no "use node"): the Convex actions and the Next.js proxy both
// tag sessions with it, so a thread carries the same ids whichever side created it.

/** The generic Kortix fields that carry Lumen's ids on a session (labels ≤ 64 chars). */
export function lumenSessionTags(a: { orgId: string; userId: string }, workspaceId: string) {
  return {
    labels: [`lumen-user:${a.userId}`.slice(0, 64), `lumen-workspace:${workspaceId}`.slice(0, 64)],
    metadata: { lumen_org_id: a.orgId, lumen_workspace_id: workspaceId, lumen_user_id: a.userId },
  };
}

/**
 * The body of a session create, with Lumen's tags applied. Lumen's labels
 * come first and a client label in the `lumen-` namespace is dropped, so a
 * member can neither attribute a session to another user or workspace nor
 * push the real tags past Kortix's 20-label limit. Lumen's metadata keys
 * overwrite the client's.
 */
export function tagSessionCreate(
  body: Record<string, unknown>,
  a: { orgId: string; userId: string },
  workspaceId: string,
): Record<string, unknown> & { labels: string[]; metadata: Record<string, unknown> } {
  const tags = lumenSessionTags(a, workspaceId);
  const clientLabels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === "string" && !l.toLowerCase().startsWith("lumen-"))
    : [];
  const metadata =
    body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : {};
  return {
    ...body,
    labels: [...new Set([...tags.labels, ...clientLabels])].slice(0, 20),
    metadata: { ...metadata, ...tags.metadata },
  };
}
