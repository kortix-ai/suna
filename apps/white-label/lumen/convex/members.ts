import { v } from "convex/values";
import { components } from "./_generated/api";
import { query } from "./_generated/server";
import { requireFirm } from "./access";

/** The firm's members (name, email, role): the matter member picker, usage and audit screens. */
export const directory = query({
  args: { firmId: v.id("firms") },
  returns: v.array(v.object({ userId: v.string(), name: v.string(), email: v.string(), role: v.string(), joinedAt: v.number() })),
  handler: async (ctx, { firmId }) => {
    const { firm } = await requireFirm(ctx, firmId);
    return ctx.runQuery(components.betterAuth.membership.directory, { organizationId: firm.orgId });
  },
});
