import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";

/** Only the Next.js server knows LUMEN_PROXY_SECRET, so only it passes this check. */
export function requireProxy(proxySecret: string) {
  const expected = process.env.LUMEN_PROXY_SECRET;
  if (!expected || proxySecret !== expected) throw new Error("403: proxy only");
}

/** The caller's role in the org, or null when not signed in or not a member. */
async function roleIn(ctx: QueryCtx, orgId: string) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return { user: null, role: null };
  const role = await ctx.runQuery(components.betterAuth.membership.role, { organizationId: orgId, userId: user._id });
  return { user, role };
}

/** True when the signed-in caller is a member of the org. Never throws. */
export async function isMember(ctx: QueryCtx, orgId: string) {
  return (await roleIn(ctx, orgId)).role !== null;
}

/** Throw 401/403 unless the caller is a member of the org. Returns the user id and role. */
export async function requireMember(ctx: QueryCtx, orgId: string) {
  const { user, role } = await roleIn(ctx, orgId);
  if (!user) throw new Error("401: not signed in");
  if (!role) throw new Error("403: not a member of this organization");
  return { userId: user._id as string, role };
}

/** Load a workspace and require org membership. */
export async function requireWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const ws: Doc<"workspaces"> | null = await ctx.db.get(workspaceId);
  if (!ws) throw new Error("404: workspace not found");
  const member = await requireMember(ctx, ws.orgId);
  return { ws, ...member };
}
