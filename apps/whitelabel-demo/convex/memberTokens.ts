import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Every token is revoked at its expiry by kortix.revokeToken (scheduled at mint),
// so a replaced row needs no revoke of its own here.
const REUSE_MARGIN_MS = 5 * 60_000;

export const valid = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  returns: v.union(v.null(), v.object({ secret: v.string(), expiresAt: v.number() })),
  handler: async (ctx, { workspaceId, userId }) => {
    const row = await ctx.db
      .query("memberTokens")
      .withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
      .unique();
    return row && row.expiresAt - REUSE_MARGIN_MS > Date.now() ? { secret: row.secret, expiresAt: row.expiresAt } : null;
  },
});

export const store = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    orgId: v.string(),
    userId: v.string(),
    tokenId: v.string(),
    secret: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("memberTokens")
      .withIndex("by_workspaceId_and_userId", (q) => q.eq("workspaceId", a.workspaceId).eq("userId", a.userId))
      .unique();
    const doc = { workspaceId: a.workspaceId, userId: a.userId, tokenId: a.tokenId, secret: a.secret, expiresAt: a.expiresAt };
    if (row) await ctx.db.replace(row._id, doc);
    else await ctx.db.insert("memberTokens", doc);
    await ctx.db.insert("auditEvents", {
      orgId: a.orgId, actorId: a.userId, action: "token.mint", workspaceId: a.workspaceId, detail: a.tokenId,
    });
    return null;
  },
});
