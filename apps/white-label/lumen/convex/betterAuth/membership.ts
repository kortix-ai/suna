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
