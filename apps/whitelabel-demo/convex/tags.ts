// Plain module (no "use node"): the Convex actions and the Next.js proxy both
// tag sessions with it, so a thread carries the same ids whichever side created it.

/** The generic Kortix fields that carry Lumen's ids on a session (labels ≤ 64 chars). */
export function lumenSessionTags(a: { orgId: string; userId: string }, workspaceId: string) {
  return {
    labels: [`lumen-user:${a.userId}`.slice(0, 64), `lumen-workspace:${workspaceId}`.slice(0, 64)],
    metadata: { lumen_org_id: a.orgId, lumen_workspace_id: workspaceId, lumen_user_id: a.userId },
  };
}
