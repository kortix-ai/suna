import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";

/** Only the Next.js server knows LUMEN_PROXY_SECRET, so only it passes this check. */
export function requireProxy(proxySecret: string) {
  const expected = process.env.LUMEN_PROXY_SECRET;
  if (!expected || proxySecret !== expected) throw new Error("403: proxy only");
}

/** Better Auth roles. "member" is shown as "Lawyer". */
export type Role = "owner" | "admin" | "member";
export const isAdminRole = (role: string | null) => role === "owner" || role === "admin";

/** The caller's role in the org, or null when not signed in or not a member. */
async function roleIn(ctx: QueryCtx, orgId: string) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return { user: null, role: null };
  const role = await ctx.runQuery(components.betterAuth.membership.role, { organizationId: orgId, userId: user._id });
  return { user, role };
}

/** The signed-in user id, or throw 401. */
export async function requireUser(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("401: not signed in");
  return user._id as string;
}

/** True when the signed-in caller is a member of the org. Never throws. */
export async function isMember(ctx: QueryCtx, orgId: string) {
  return (await roleIn(ctx, orgId)).role !== null;
}

/** Throw 401/403 unless the caller is a member of the org. Returns the user id and role. */
export async function requireMember(ctx: QueryCtx, orgId: string) {
  const { user, role } = await roleIn(ctx, orgId);
  if (!user) throw new Error("401: not signed in");
  if (!role) throw new Error("403: not a member of this firm");
  return { userId: user._id as string, role: role as Role };
}

/** Load a firm and require membership. */
export async function requireFirm(ctx: QueryCtx, firmId: Id<"firms">) {
  const firm: Doc<"firms"> | null = await ctx.db.get(firmId);
  if (!firm) throw new Error("404: firm not found");
  return { firm, ...(await requireMember(ctx, firm.orgId)) };
}

/** Load a firm and require owner or admin. */
export async function requireFirmAdmin(ctx: QueryCtx, firmId: Id<"firms">) {
  const got = await requireFirm(ctx, firmId);
  if (!isAdminRole(got.role)) throw new Error("403: admins only");
  return got;
}

/** True when a member with this role may see the matter. */
export async function canSeeMatter(ctx: QueryCtx, matter: Doc<"matters">, userId: string, role: string) {
  if (matter.visibility === "firm" || isAdminRole(role) || matter.createdBy === userId) return true;
  const row = await ctx.db
    .query("matterMembers")
    .withIndex("by_matter_user", (q) => q.eq("matterId", matter._id).eq("userId", userId))
    .unique();
  return row !== null;
}

/**
 * The one access check for a matter: the caller is a firm member and, for a
 * restricted matter, an admin, its creator or a listed matter member.
 * Every matter query and mutation goes through it.
 */
export async function requireMatterAccess(ctx: QueryCtx, matterId: Id<"matters">) {
  const matter = await ctx.db.get(matterId);
  if (!matter) throw new Error("404: matter not found");
  const { firm, userId, role } = await requireFirm(ctx, matter.firmId);
  if (!(await canSeeMatter(ctx, matter, userId, role))) throw new Error("403: no access to this matter");
  return { matter, firm, userId, role };
}
