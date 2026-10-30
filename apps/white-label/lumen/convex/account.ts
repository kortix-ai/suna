// A person's own account: what Lumen holds about them (export) and leaving Lumen (delete).
// The firm's work stays with the firm: matters, documents, threads and the audit log are
// the firm's records. Deleting an account removes the person, their sign-in, their firm
// memberships and their place on restricted matters.

import { v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { canSeeMatter, requireFirm } from "./access";
import { authComponent } from "./auth";

/** Everything Lumen holds about the caller in this firm, as one JSON document. */
export const myData = query({
  args: { firmId: v.id("firms") },
  returns: v.any(),
  handler: async (ctx, { firmId }) => {
    const { firm, userId, role } = await requireFirm(ctx, firmId);
    const user = await authComponent.getAuthUser(ctx);
    const visible = async (matterId: string) => {
      const m = await ctx.db.get(matterId as never);
      return m && (await canSeeMatter(ctx, m as never, userId, role)) ? (m as { name: string }).name : null;
    };
    const matters = (await ctx.db.query("matters").withIndex("by_firm_updatedAt", (q) => q.eq("firmId", firmId)).collect())
      .filter((m) => m.createdBy === userId)
      .map((m) => ({ id: m._id, name: m.name, client: m.client, status: m.status, visibility: m.visibility, created: new Date(m._creationTime).toISOString() }));
    const threads = [];
    for (const t of (await ctx.db.query("threads").withIndex("by_firm", (q) => q.eq("firmId", firmId)).collect()).filter((t) => t.createdBy === userId)) {
      threads.push({ id: t._id, title: t.title, matter: await visible(t.matterId), created: new Date(t._creationTime).toISOString() });
    }
    const documents = [];
    for (const m of await ctx.db.query("matters").withIndex("by_firm_updatedAt", (q) => q.eq("firmId", firmId)).collect()) {
      if (!(await canSeeMatter(ctx, m, userId, role))) continue;
      for (const d of await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", m._id)).collect()) {
        if (d.uploadedBy === userId) documents.push({ id: d._id, filename: d.filename, matter: m.name, version: d.version ?? 1, bytes: d.bytes, uploaded: new Date(d._creationTime).toISOString() });
      }
    }
    const activity = (await ctx.db.query("auditEvents").withIndex("by_orgId", (q) => q.eq("orgId", firm.orgId)).order("desc").take(5000))
      .filter((r) => r.actorId === userId)
      .map((r) => ({ when: new Date(r._creationTime).toISOString(), action: r.action, detail: r.detail ?? null }));
    return {
      exported: new Date().toISOString(),
      profile: { id: userId, name: user.name, email: user.email, emailVerified: user.emailVerified, created: new Date(user.createdAt).toISOString() },
      firm: { name: firm.name, role },
      matters, threads, documents, activity,
    };
  },
});

/** Firms this user is the only owner of: their account cannot be deleted until each has another owner. */
export const soleOwnerOf = internalQuery({
  args: { userId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { userId }) =>
    (await ctx.runQuery(components.betterAuth.membership.soleOwnerOf, { userId })).map((o) => o.name),
});

/** After Better Auth deleted the user: their memberships, their place on restricted matters, one audit row per firm. */
export const forgetUser = internalMutation({
  args: { userId: v.string(), email: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, email }) => {
    const orgs = await ctx.runMutation(components.betterAuth.membership.removeUser, { userId });
    for (const orgId of orgs) {
      const firm = await ctx.db.query("firms").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).unique();
      await ctx.db.insert("auditEvents", { firmId: firm?._id, orgId, actorId: userId, action: "member.remove", detail: `${email} deleted their account` });
    }
    for (const row of await ctx.db.query("matterMembers").collect()) {
      if (row.userId === userId) await ctx.db.delete(row._id);
    }
    return null;
  },
});
