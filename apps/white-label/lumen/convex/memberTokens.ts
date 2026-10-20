import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { audit } from "./audit";

// Every token is revoked at its expiry by kortix.revokeToken (scheduled at mint),
// so a replaced row needs no revoke of its own here.
const REUSE_MARGIN_MS = 5 * 60_000;

export const valid = internalQuery({
  args: { firmId: v.id("firms"), userId: v.string() },
  returns: v.union(v.null(), v.object({ secret: v.string(), expiresAt: v.number() })),
  handler: async (ctx, { firmId, userId }) => {
    const row = await ctx.db
      .query("memberTokens")
      .withIndex("by_firm_user", (q) => q.eq("firmId", firmId).eq("userId", userId))
      .unique();
    return row && row.expiresAt - REUSE_MARGIN_MS > Date.now() ? { secret: row.secret, expiresAt: row.expiresAt } : null;
  },
});

export const store = internalMutation({
  args: {
    firmId: v.id("firms"),
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
      .withIndex("by_firm_user", (q) => q.eq("firmId", a.firmId).eq("userId", a.userId))
      .unique();
    const doc = { firmId: a.firmId, userId: a.userId, tokenId: a.tokenId, secret: a.secret, expiresAt: a.expiresAt };
    if (row) await ctx.db.replace(row._id, doc);
    else await ctx.db.insert("memberTokens", doc);
    await audit(ctx, { firm: { _id: a.firmId, orgId: a.orgId }, actorId: a.userId, action: "token.mint", detail: "1 h workspace access" });
    return null;
  },
});
