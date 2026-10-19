import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { isMember, requireMember, requireWorkspace } from "./access";

const workspace = v.object({
  _id: v.id("workspaces"),
  _creationTime: v.number(),
  orgId: v.string(),
  name: v.string(),
  templateSlug: v.string(),
  kortixProjectId: v.union(v.null(), v.string()),
  status: v.union(v.literal("provisioning"), v.literal("ready"), v.literal("failed")),
  error: v.optional(v.string()),
  createdBy: v.string(),
});

export const list = query({
  args: { orgId: v.string() },
  returns: v.array(workspace),
  handler: async (ctx, { orgId }) => {
    // A non-member sees an empty list; writes and actions throw 403 instead.
    if (!(await isMember(ctx, orgId))) return [];
    return ctx.db.query("workspaces").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).order("desc").take(100);
  },
});

/** One workspace, or null when it does not exist or the caller is not a member (the UI shows one state for both). */
export const get = query({
  args: { workspaceId: v.string() },
  returns: v.union(v.null(), workspace),
  handler: async (ctx, { workspaceId }) => {
    const id = ctx.db.normalizeId("workspaces", workspaceId);
    const ws = id ? await ctx.db.get(id) : null;
    return ws && (await isMember(ctx, ws.orgId)) ? ws : null;
  },
});

/**
 * The workspace behind a Kortix project id taken from a URL. The id is only a
 * lookup key: the caller must be a member of the workspace's org, and the
 * proxy derives the Kortix credential from the workspace, never from this id.
 */
export const byProject = query({
  args: { kortixProjectId: v.string() },
  returns: v.union(v.null(), workspace),
  handler: async (ctx, { kortixProjectId }) => {
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_kortixProjectId", (q) => q.eq("kortixProjectId", kortixProjectId))
      .unique();
    return ws && (await isMember(ctx, ws.orgId)) ? ws : null;
  },
});

/** A failed provision runs again. The idempotency key (the workspace id) keeps it to one Kortix project. */
export const retry = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const { ws } = await requireWorkspace(ctx, workspaceId);
    if (ws.status !== "failed") return null;
    await ctx.db.patch(workspaceId, { status: "provisioning", error: undefined });
    await ctx.scheduler.runAfter(0, internal.kortix.provisionWorkspace, { workspaceId });
    return null;
  },
});

/** Insert the row, then provision the Kortix project in the background. */
export const create = mutation({
  args: { orgId: v.string(), name: v.string(), templateSlug: v.string() },
  returns: v.id("workspaces"),
  handler: async (ctx, args) => {
    const { userId } = await requireMember(ctx, args.orgId);
    const name = args.name.trim();
    if (name.length < 1 || name.length > 80) throw new Error("400: name must be 1-80 characters");
    const tpl = await ctx.db.query("agentTemplates").withIndex("by_slug", (q) => q.eq("slug", args.templateSlug)).unique();
    if (!tpl) throw new Error("400: unknown template");
    const workspaceId = await ctx.db.insert("workspaces", {
      orgId: args.orgId, name, templateSlug: tpl.slug, kortixProjectId: null, status: "provisioning", createdBy: userId,
    });
    await ctx.db.insert("auditEvents", { orgId: args.orgId, actorId: userId, action: "workspace.create", workspaceId });
    await ctx.scheduler.runAfter(0, internal.kortix.provisionWorkspace, { workspaceId });
    return workspaceId;
  },
});

// ── internal: read/written by the Kortix actions ──

export const forProvision = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.object({ ws: workspace, agent: v.object({ prompt: v.string(), model: v.optional(v.string()), skills: v.optional(v.array(v.string())) }) })),
  handler: async (ctx, { workspaceId }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) return null;
    const tpl = await ctx.db.query("agentTemplates").withIndex("by_slug", (q) => q.eq("slug", ws.templateSlug)).unique();
    return tpl ? { ws, agent: tpl.agent } : null;
  },
});

export const settle = internalMutation({
  args: { workspaceId: v.id("workspaces"), kortixProjectId: v.union(v.null(), v.string()), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, kortixProjectId, error }) => {
    const ws = await ctx.db.get(workspaceId);
    if (!ws) return null;
    await ctx.db.patch(workspaceId, error ? { status: "failed", error } : { status: "ready", kortixProjectId });
    await ctx.db.insert("auditEvents", {
      orgId: ws.orgId, actorId: "system", action: error ? "workspace.failed" : "workspace.ready", workspaceId, detail: error ?? kortixProjectId ?? undefined,
    });
    return null;
  },
});

/** Membership + project for an action that acts on behalf of the caller. */
export const access = internalQuery({
  args: { workspaceId: v.string() },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    orgId: v.string(),
    kortixProjectId: v.string(),
    templateSlug: v.string(),
  }),
  handler: async (ctx, { workspaceId }) => {
    const id = ctx.db.normalizeId("workspaces", workspaceId);
    if (!id) throw new Error("404: workspace not found");
    const { ws, userId } = await requireWorkspace(ctx, id);
    if (!ws.kortixProjectId) throw new Error("409: workspace is still provisioning");
    return { workspaceId: id, userId, orgId: ws.orgId, kortixProjectId: ws.kortixProjectId, templateSlug: ws.templateSlug };
  },
});
