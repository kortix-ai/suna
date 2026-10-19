import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";

/** The signed-in Better Auth user, or throw 401. */
export async function requireUser(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("401: not signed in");
  return user;
}

/** True when the signed-in caller is a member of the org. Never throws. */
export async function isMember(ctx: QueryCtx, orgId: string) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return false;
  const role = await ctx.runQuery(components.betterAuth.membership.role, { organizationId: orgId, userId: user._id });
  return role !== null;
}

/** Throw 403 unless the caller is a member of the org. Returns the user id and role. */
export async function requireMember(ctx: QueryCtx, orgId: string) {
  const user = await requireUser(ctx);
  const role = await ctx.runQuery(components.betterAuth.membership.role, {
    organizationId: orgId,
    userId: user._id,
  });
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
