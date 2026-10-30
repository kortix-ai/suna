import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { isAdminRole, requireMatterAccess, requireProxy } from "./access";
import { audit } from "./audit";
import { projectIdOf } from "./deployment";

/** A thread as the browser sees it. The Kortix ids are what the session view needs to stream. */
const thread = v.object({
  _id: v.id("threads"),
  _creationTime: v.number(),
  matterId: v.id("matters"),
  kortixSessionId: v.string(),
  title: v.string(),
  createdBy: v.string(),
  lastMessageAt: v.number(),
});

const pick = (t: { _id: Id<"threads">; _creationTime: number; matterId: Id<"matters">; kortixSessionId: string; title: string; createdBy: string; lastMessageAt: number }) => ({
  _id: t._id, _creationTime: t._creationTime, matterId: t.matterId, kortixSessionId: t.kortixSessionId, title: t.title,
  createdBy: t.createdBy, lastMessageAt: t.lastMessageAt,
});

export const list = query({
  args: { matterId: v.id("matters") },
  returns: v.array(thread),
  handler: async (ctx, { matterId }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return [];
    }
    const rows = await ctx.db.query("threads").withIndex("by_matter", (q) => q.eq("matterId", matterId)).order("desc").take(200);
    return rows.map(pick).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});

/** One thread with the shared Kortix project id (the session view needs it), or null. */
export const get = query({
  args: { threadId: v.string() },
  returns: v.union(v.null(), v.object({ thread, kortixProjectId: v.string() })),
  handler: async (ctx, { threadId }) => {
    const id = ctx.db.normalizeId("threads", threadId);
    const t = id ? await ctx.db.get(id) : null;
    if (!t) return null;
    try {
      await requireMatterAccess(ctx, t.matterId);
      const kortixProjectId = await projectIdOf(ctx);
      return kortixProjectId ? { thread: pick(t), kortixProjectId } : null;
    } catch {
      return null;
    }
  },
});

/** The thread behind a Kortix session the caller just created through the proxy. */
export const bySession = query({
  args: { kortixSessionId: v.string() },
  returns: v.union(v.null(), v.object({ threadId: v.id("threads"), matterId: v.id("matters") })),
  handler: async (ctx, { kortixSessionId }) => {
    const t = await ctx.db.query("threads").withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", kortixSessionId)).unique();
    if (!t) return null;
    try {
      await requireMatterAccess(ctx, t.matterId);
      return { threadId: t._id, matterId: t.matterId };
    } catch {
      return null;
    }
  },
});

type RecordArgs = { firmId: Id<"firms">; matterId: Id<"matters">; orgId: string; userId: string; kortixSessionId: string; title: string };

/** Insert a thread once per Kortix session, with its audit event. */
async function insertThread(ctx: MutationCtx, a: RecordArgs): Promise<Id<"threads">> {
  const existing = await ctx.db
    .query("threads")
    .withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", a.kortixSessionId))
    .unique();
  if (existing) return existing._id;
  const now = Date.now();
  const id = await ctx.db.insert("threads", {
    firmId: a.firmId, matterId: a.matterId, kortixSessionId: a.kortixSessionId, title: a.title, createdBy: a.userId, lastMessageAt: now,
  });
  await ctx.db.patch(a.matterId, { updatedAt: now });
  await audit(ctx, { firm: { _id: a.firmId, orgId: a.orgId }, actorId: a.userId, action: "thread.create", matterId: a.matterId, detail: a.title });
  return id;
}

export const record = internalMutation({
  args: {
    firmId: v.id("firms"), matterId: v.id("matters"), orgId: v.string(), userId: v.string(), kortixSessionId: v.string(), title: v.string(),
  },
  returns: v.id("threads"),
  handler: (ctx, a) => insertThread(ctx, a),
});

/**
 * A session the session UI created through the proxy (for example "new
 * session with this scope") becomes a Lumen thread in the same matter.
 * Only the Next.js proxy calls this: it knows LUMEN_PROXY_SECRET.
 */
export const recordFromProxy = mutation({
  args: { matterId: v.id("matters"), kortixSessionId: v.string(), title: v.string(), proxySecret: v.string() },
  returns: v.id("threads"),
  handler: async (ctx, a): Promise<Id<"threads">> => {
    requireProxy(a.proxySecret);
    const { firm, userId } = await requireMatterAccess(ctx, a.matterId);
    return insertThread(ctx, {
      firmId: firm._id, matterId: a.matterId, orgId: firm.orgId, userId, kortixSessionId: a.kortixSessionId,
      title: a.title.trim().slice(0, 120) || "New thread",
    });
  },
});

/** A member renamed a thread's session through the proxy: the thread list shows the new name. */
export const renameFromProxy = mutation({
  args: { matterId: v.id("matters"), kortixSessionId: v.string(), title: v.string(), proxySecret: v.string() },
  returns: v.null(),
  handler: async (ctx, a) => {
    requireProxy(a.proxySecret);
    await requireMatterAccess(ctx, a.matterId);
    const row = await ctx.db
      .query("threads")
      .withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", a.kortixSessionId))
      .unique();
    const title = a.title.trim().slice(0, 120);
    if (row && row.matterId === a.matterId && title && row.title !== title) await ctx.db.patch(row._id, { title });
    return null;
  },
});

/**
 * A member deletes a thread's session through the proxy. Only the thread's
 * creator or a firm owner/admin may. `remove: false` checks, and the proxy
 * then deletes the session; `remove: true` drops the thread record and
 * writes the audit event. Only the Next.js proxy calls this.
 */
export const deleteFromProxy = mutation({
  args: { matterId: v.id("matters"), kortixSessionId: v.string(), proxySecret: v.string(), remove: v.boolean() },
  returns: v.null(),
  handler: async (ctx, a) => {
    requireProxy(a.proxySecret);
    const { firm, userId, role } = await requireMatterAccess(ctx, a.matterId);
    const row = await ctx.db
      .query("threads")
      .withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", a.kortixSessionId))
      .unique();
    if (!row || row.matterId !== a.matterId) throw new Error("404: thread not found");
    if (row.createdBy !== userId && !isAdminRole(role)) {
      throw new Error("403: only the thread's creator or an admin may delete it");
    }
    if (!a.remove) return null;
    await ctx.db.delete(row._id);
    await audit(ctx, { firm, actorId: userId, action: "thread.delete", matterId: a.matterId, detail: row.title });
    return null;
  },
});
