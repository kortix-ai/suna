// Workflows a firm writes itself: an assistant workflow is instructions a
// thread starts with; a tabular workflow is a column set a review starts with.
// A workflow is private to its author or shared with the whole firm. The
// built-in workflows (contract review, diligence, draft) stay in workflows.ts.

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { isAdminRole, requireFirm } from "./access";
import { audit } from "./audit";
import { checkColumns } from "./runs";
import { column } from "./schema";

const workflowView = v.object({
  _id: v.id("customWorkflows"), type: v.union(v.literal("assistant"), v.literal("tabular")), name: v.string(),
  description: v.optional(v.string()), prompt: v.optional(v.string()), columns: v.optional(v.array(column)),
  practiceArea: v.optional(v.string()), jurisdiction: v.optional(v.string()),
  visibility: v.union(v.literal("private"), v.literal("firm")), mine: v.boolean(), canEdit: v.boolean(), updatedAt: v.number(),
});

const viewOf = (w: Doc<"customWorkflows">, userId: string, role: string) => ({
  _id: w._id, type: w.type, name: w.name, description: w.description, prompt: w.prompt, columns: w.columns,
  practiceArea: w.practiceArea, jurisdiction: w.jurisdiction, visibility: w.visibility, mine: w.createdBy === userId,
  canEdit: w.createdBy === userId || (w.visibility === "firm" && isAdminRole(role)), updatedAt: w.updatedAt,
});

const visible = (w: Doc<"customWorkflows">, userId: string) => w.visibility === "firm" || w.createdBy === userId;

/** The firm's shared workflows and the caller's own private ones, newest first. [] for a non-member. */
export const list = query({
  args: { firmId: v.id("firms") },
  returns: v.array(workflowView),
  handler: async (ctx, { firmId }) => {
    let me;
    try {
      me = await requireFirm(ctx, firmId);
    } catch {
      return [];
    }
    const rows = await ctx.db.query("customWorkflows").withIndex("by_firm", (q) => q.eq("firmId", firmId)).order("desc").take(500);
    return rows.filter((w) => visible(w, me.userId)).map((w) => viewOf(w, me.userId, me.role));
  },
});

const short = (s: string | undefined, n: number) => s?.trim().slice(0, n) || undefined;

/** Create or edit a workflow. The author edits their own; an admin also edits the firm's shared ones. */
export const save = mutation({
  args: {
    firmId: v.id("firms"), workflowId: v.optional(v.id("customWorkflows")),
    type: v.union(v.literal("assistant"), v.literal("tabular")), name: v.string(), description: v.optional(v.string()),
    prompt: v.optional(v.string()), columns: v.optional(v.array(column)), practiceArea: v.optional(v.string()),
    jurisdiction: v.optional(v.string()), visibility: v.union(v.literal("private"), v.literal("firm")),
  },
  returns: v.id("customWorkflows"),
  handler: async (ctx, a) => {
    const { firm, userId, role } = await requireFirm(ctx, a.firmId);
    const name = a.name.trim().slice(0, 120);
    if (!name) throw new Error("400: a workflow needs a name");
    const prompt = a.prompt?.trim().slice(0, 20_000) || undefined;
    if (a.type === "assistant" && (!prompt || prompt.length < 10)) throw new Error("400: write the instructions (at least 10 characters)");
    const columns = a.type === "tabular" ? checkColumns(a.columns ?? []) : undefined;
    const row = {
      type: a.type, name, description: short(a.description, 300), prompt, columns, practiceArea: short(a.practiceArea, 80),
      jurisdiction: short(a.jurisdiction, 80), visibility: a.visibility, updatedAt: Date.now(),
    };
    if (a.workflowId) {
      const w = await ctx.db.get(a.workflowId);
      if (!w || w.firmId !== firm._id || !visible(w, userId)) throw new Error("404: workflow not found");
      if (!viewOf(w, userId, role).canEdit) throw new Error("403: only the author or an admin edits this workflow");
      await ctx.db.patch(a.workflowId, row);
      await audit(ctx, { firm, actorId: userId, action: "workflow.update", detail: `${a.type}: ${name}` });
      return a.workflowId;
    }
    const id = await ctx.db.insert("customWorkflows", { firmId: firm._id, createdBy: userId, ...row });
    await audit(ctx, { firm, actorId: userId, action: "workflow.create", detail: `${a.type}: ${name} (${a.visibility})` });
    return id;
  },
});

export const remove = mutation({
  args: { workflowId: v.id("customWorkflows") },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const w = await ctx.db.get(workflowId);
    if (!w) throw new Error("404: workflow not found");
    const { firm, userId, role } = await requireFirm(ctx, w.firmId);
    if (!visible(w, userId)) throw new Error("404: workflow not found");
    if (!viewOf(w, userId, role).canEdit) throw new Error("403: only the author or an admin deletes this workflow");
    await ctx.db.delete(workflowId);
    await audit(ctx, { firm, actorId: userId, action: "workflow.delete", detail: `${w.type}: ${w.name}` });
    return null;
  },
});
