import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { isMember, requireProxy, requireWorkspace } from "./access";

const thread = v.object({
  _id: v.id("threads"),
  _creationTime: v.number(),
  workspaceId: v.id("workspaces"),
  kortixSessionId: v.string(),
  title: v.string(),
  createdBy: v.string(),
});

export const list = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(thread),
  handler: async (ctx, { workspaceId }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws || !(await isMember(ctx, ws.orgId))) return [];
    return ctx.db.query("threads").withIndex("by_workspaceId", (q) => q.eq("workspaceId", workspaceId)).order("desc").take(100);
  },
});

type RecordArgs = { workspaceId: Id<"workspaces">; orgId: string; userId: string; kortixSessionId: string; title: string };

/** Insert a thread once per Kortix session, with its audit event. */
async function insertThread(ctx: MutationCtx, a: RecordArgs): Promise<Id<"threads">> {
  const existing = await ctx.db
    .query("threads")
    .withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", a.kortixSessionId))
    .unique();
  if (existing) return existing._id;
  const id = await ctx.db.insert("threads", {
    workspaceId: a.workspaceId,
    kortixSessionId: a.kortixSessionId,
    title: a.title,
    createdBy: a.userId,
  });
  await ctx.db.insert("auditEvents", {
    orgId: a.orgId, actorId: a.userId, action: "thread.create", workspaceId: a.workspaceId, detail: a.kortixSessionId,
  });
  return id;
}

export const record = internalMutation({
  args: { workspaceId: v.id("workspaces"), orgId: v.string(), userId: v.string(), kortixSessionId: v.string(), title: v.string() },
  returns: v.id("threads"),
  handler: (ctx, a) => insertThread(ctx, a),
});

/**
 * A session the session UI created through the proxy (for example "new
 * session with this scope") becomes a Lumen thread too. Only the Next.js
 * proxy calls this: it knows LUMEN_PROXY_SECRET.
 */
export const recordFromProxy = mutation({
  args: { workspaceId: v.id("workspaces"), kortixSessionId: v.string(), title: v.string(), proxySecret: v.string() },
  returns: v.id("threads"),
  handler: async (ctx, a): Promise<Id<"threads">> => {
    requireProxy(a.proxySecret);
    const { ws, userId } = await requireWorkspace(ctx, a.workspaceId);
    return insertThread(ctx, {
      workspaceId: a.workspaceId,
      orgId: ws.orgId,
      userId,
      kortixSessionId: a.kortixSessionId,
      title: a.title.trim().slice(0, 120) || "New thread",
    });
  },
});

/**
 * A member deletes a thread's Kortix session through the proxy. Only the
 * thread's creator or an org owner/admin may. `remove: false` checks, and the
 * proxy then deletes the session on Kortix; `remove: true` drops the thread
 * record and writes the audit event. Only the Next.js proxy calls this.
 */
export const deleteFromProxy = mutation({
  args: { workspaceId: v.id("workspaces"), kortixSessionId: v.string(), proxySecret: v.string(), remove: v.boolean() },
  returns: v.null(),
  handler: async (ctx, a) => {
    requireProxy(a.proxySecret);
    const { ws, userId, role } = await requireWorkspace(ctx, a.workspaceId);
    const row = await ctx.db
      .query("threads")
      .withIndex("by_kortixSessionId", (q) => q.eq("kortixSessionId", a.kortixSessionId))
      .unique();
    if (!row || row.workspaceId !== a.workspaceId) throw new Error("404: thread not found");
    if (row.createdBy !== userId && role !== "owner" && role !== "admin") {
      throw new Error("403: only the thread's creator or an admin may delete it");
    }
    if (!a.remove) return null;
    await ctx.db.delete(row._id);
    await ctx.db.insert("auditEvents", {
      orgId: ws.orgId, actorId: userId, action: "thread.delete", workspaceId: a.workspaceId, detail: a.kortixSessionId,
    });
    return null;
  },
});
