import { type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { requireFirmAdmin } from "./access";
import { auditAction } from "./schema";

type Action = Infer<typeof auditAction>;

/** Append one audit event. The log has no update or delete path. */
export async function audit(
  ctx: MutationCtx,
  e: { firm: Pick<Doc<"firms">, "_id" | "orgId">; actorId: string; action: Action; matterId?: Id<"matters">; detail?: string },
) {
  await ctx.db.insert("auditEvents", {
    firmId: e.firm._id, orgId: e.firm.orgId, actorId: e.actorId, action: e.action, matterId: e.matterId, detail: e.detail?.slice(0, 500),
  });
}

/** Called from Better Auth's organization hooks (member and invitation events). */
export const logOrgEvent = internalMutation({
  args: { orgId: v.string(), actorId: v.string(), action: auditAction, detail: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const firm = await ctx.db.query("firms").withIndex("by_orgId", (q) => q.eq("orgId", a.orgId)).unique();
    await ctx.db.insert("auditEvents", { firmId: firm?._id, orgId: a.orgId, actorId: a.actorId, action: a.action, detail: a.detail });
    return null;
  },
});

const row = v.object({
  _id: v.id("auditEvents"),
  _creationTime: v.number(),
  actorId: v.string(),
  action: auditAction,
  matterId: v.optional(v.id("matters")),
  matterName: v.optional(v.string()),
  detail: v.optional(v.string()),
});

/** Admin: the newest 500 events, optionally of one action. The UI filters by actor and matter. */
export const list = query({
  args: { firmId: v.id("firms"), action: v.optional(auditAction) },
  returns: v.array(row),
  handler: async (ctx, { firmId, action }) => {
    const { firm } = await requireFirmAdmin(ctx, firmId);
    const rows = action
      ? await ctx.db.query("auditEvents").withIndex("by_orgId_action", (q) => q.eq("orgId", firm.orgId).eq("action", action)).order("desc").take(500)
      : await ctx.db.query("auditEvents").withIndex("by_orgId", (q) => q.eq("orgId", firm.orgId)).order("desc").take(500);
    const names = new Map<string, string>();
    for (const r of rows) {
      if (r.matterId && !names.has(r.matterId)) names.set(r.matterId, (await ctx.db.get(r.matterId))?.name ?? "");
    }
    return rows.map((r) => ({
      _id: r._id, _creationTime: r._creationTime, actorId: r.actorId, action: r.action, matterId: r.matterId,
      matterName: r.matterId ? names.get(r.matterId) : undefined, detail: r.detail,
    }));
  },
});

/** Admin: record that someone exported data (the CSV is built in the browser from data they already read). */
export const logExport = mutation({
  args: { firmId: v.id("firms"), what: v.string() },
  returns: v.null(),
  handler: async (ctx, { firmId, what }) => {
    const { firm, userId } = await requireFirmAdmin(ctx, firmId);
    await audit(ctx, { firm, actorId: userId, action: "export.csv", detail: what.slice(0, 80) });
    return null;
  },
});
