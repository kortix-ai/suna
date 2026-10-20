import { v } from "convex/values";
import { query } from "./_generated/server";

/** The caller's role in one org, or null. Called from the app via components.betterAuth.membership.role. */
export const role = query({
  args: { organizationId: v.string(), userId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("member")
      .withIndex("organizationId_userId", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId),
      )
      .unique();
    return row?.role ?? null;
  },
});

/** Active members and pending, unexpired invitations: the seat rule counts both. */
export const seatUse = query({
  args: { organizationId: v.string() },
  returns: v.object({ members: v.number(), pending: v.number() }),
  handler: async (ctx, { organizationId }) => {
    const members = await ctx.db
      .query("member")
      .withIndex("organizationId", (q) => q.eq("organizationId", organizationId))
      .take(1000);
    const now = Date.now();
    const pending = (
      await ctx.db
        .query("invitation")
        .withIndex("organizationId_status", (q) => q.eq("organizationId", organizationId).eq("status", "pending"))
        .take(1000)
    ).filter((i) => i.expiresAt > now);
    return { members: members.length, pending: pending.length };
  },
});

/** Members with name and email, for the firm's own screens (members, usage, audit). */
export const directory = query({
  args: { organizationId: v.string() },
  returns: v.array(v.object({ userId: v.string(), name: v.string(), email: v.string(), role: v.string(), joinedAt: v.number() })),
  handler: async (ctx, { organizationId }) => {
    const members = await ctx.db
      .query("member")
      .withIndex("organizationId", (q) => q.eq("organizationId", organizationId))
      .take(1000);
    const out = [];
    for (const m of members) {
      const id = ctx.db.normalizeId("user", m.userId);
      const u = id ? await ctx.db.get(id) : null;
      out.push({ userId: m.userId, name: u?.name ?? "", email: u?.email ?? "", role: m.role, joinedAt: m.createdAt });
    }
    return out;
  },
});
