// Lumen's workflows: each one is a run on the same engine as a review, with its
// own agent and result contract.
//   contract review  → lumen-reviewer, 1 batch: issues.json + redline.docx
//   due diligence    → lumen-extractor map batches (the DD checklist, a review) + 1 lumen-counsel reduce batch: report.json
//   draft            → lumen-drafter, 1 batch: draft.json + draft.docx
//   ask              → lumen-counsel, 1 batch: answer.json  (runs.ask)

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { type MutationCtx, type QueryCtx, action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { canSeeMatter, requireFirm, requireMatterAccess } from "./access";
import { audit } from "./audit";
import { templateFields } from "./library";
import { type Actor, DD_COLUMNS, asOwner, createReview, createRun, readyDocs, requireRun } from "./runs";

async function libraryItem(ctx: QueryCtx, firm: Doc<"firms">, itemId: Id<"libraryItems">, kind: "playbook" | "template") {
  const item = await ctx.db.get(itemId);
  if (!item || item.firmId !== firm._id || item.kind !== kind) throw new Error(`404: ${kind} not found`);
  return item;
}

const contractArgs = {
  matterId: v.id("matters"), documentId: v.id("documents"), playbookId: v.id("libraryItems"), perspective: v.optional(v.string()),
};
async function contractReviewFor(ctx: MutationCtx, actor: Actor, a: { documentId: Id<"documents">; playbookId: Id<"libraryItems">; perspective?: string }) {
  const [doc] = await readyDocs(ctx, actor.matter._id, [a.documentId]);
  const playbook = await libraryItem(ctx, actor.firm, a.playbookId, "playbook");
  const client = actor.matter.parties.find((p) => p.role === "client")?.name ?? actor.matter.client;
  const perspective = a.perspective?.trim().slice(0, 200) || client;
  return await createRun(ctx, {
    ...actor, kind: "contract_review", title: `${doc.filename} against ${playbook.name}`.slice(0, 120), docs: [doc],
    libraryItemId: playbook._id, perspective,
  });
}

/** Review one contract against a firm playbook, from our client's side: issues by rule, severity, redlines, and a tracked-changes DOCX. */
export const startContractReview = mutation({
  args: contractArgs,
  returns: v.id("runs"),
  handler: async (ctx, a) => contractReviewFor(ctx, await requireMatterAccess(ctx, a.matterId), a),
});

const diligenceArgs = { matterId: v.id("matters"), documentIds: v.optional(v.array(v.id("documents"))) };
async function diligenceFor(ctx: MutationCtx, actor: Actor, a: { documentIds?: Id<"documents">[] }) {
  // The checklist is a review like any other: the lawyer can open it, verify cells and export it.
  const { reviewId, docs } = await createReview(ctx, actor, {
    title: `Due diligence checklist: ${actor.matter.name}`.slice(0, 120), documentIds: a.documentIds, columns: DD_COLUMNS,
  });
  return await createRun(ctx, { ...actor, kind: "diligence", title: `Due diligence: ${actor.matter.name}`.slice(0, 120), docs, reviewId });
}

/** Due diligence over the vault: a checklist row per document, then a cited report with red flags. */
export const startDiligence = mutation({
  args: diligenceArgs,
  returns: v.id("runs"),
  handler: async (ctx, a) => diligenceFor(ctx, await requireMatterAccess(ctx, a.matterId), a),
});

const draftArgs = {
  matterId: v.id("matters"), templateId: v.id("libraryItems"), fields: v.record(v.string(), v.string()),
  documentIds: v.optional(v.array(v.id("documents"))),
};
async function draftFor(ctx: MutationCtx, actor: Actor, a: { templateId: Id<"libraryItems">; fields: Record<string, string>; documentIds?: Id<"documents">[] }) {
  const template = await libraryItem(ctx, actor.firm, a.templateId, "template");
  const known = new Set(templateFields(template.body));
  const fields = Object.fromEntries(
    Object.entries(a.fields).filter(([k, val]) => known.has(k) && val.trim()).map(([k, val]) => [k, val.trim().slice(0, 500)]),
  );
  const docs = a.documentIds?.length ? await readyDocs(ctx, actor.matter._id, a.documentIds) : [];
  return await createRun(ctx, {
    ...actor, kind: "draft", title: `${template.name}: ${actor.matter.name}`.slice(0, 120), docs, libraryItemId: template._id, fields,
  });
}

/** Draft from a firm template: the fields the lawyer gives, terms from cited source documents, a DOCX to download. */
export const startDraft = mutation({
  args: draftArgs,
  returns: v.id("runs"),
  handler: async (ctx, a) => draftFor(ctx, await requireMatterAccess(ctx, a.matterId), a),
});

/** Accept or dismiss one contract-review issue. Audited. */
export const decideIssue = mutation({
  args: { issueId: v.id("issues"), decision: v.union(v.literal("accepted"), v.literal("dismissed"), v.literal("open")) },
  returns: v.null(),
  handler: async (ctx, { issueId, decision }) => {
    const issue = await ctx.db.get(issueId);
    if (!issue) throw new Error("404: issue not found");
    const { firm, userId } = await requireRun(ctx, issue.runId);
    await ctx.db.patch(issueId, { decision });
    if (decision !== "open") {
      await audit(ctx, {
        firm, actorId: userId, action: decision === "accepted" ? "issue.accept" : "issue.dismiss", matterId: issue.matterId,
        detail: `${issue.ruleId}: ${issue.title}`,
      });
    }
    return null;
  },
});

/** The audit trail of a DOCX download (the browser fetches the file from Lumen's storage). */
export const logExport = mutation({
  /** `title`: what the file is of, when that is not the run (a review's CSV is the whole review, not its last column run). */
  args: { runId: v.id("runs"), file: v.string(), title: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { runId, file, title }) => {
    const { run, firm, userId } = await requireRun(ctx, runId);
    const action = file.endsWith(".csv") ? "export.csv" : file.endsWith(".xlsx") ? "export.xlsx" : file.endsWith(".md") ? "export.md" : "export.docx";
    await audit(ctx, { firm, actorId: userId, action, matterId: run.matterId, detail: `${(title ?? run.title).slice(0, 120)}: ${file}` });
    return null;
  },
});

/** A file a run produced (redline.docx, draft.docx), through Lumen's backend after the matter access check. */
export const fileBytes = action({
  args: { runId: v.id("runs"), name: v.string() },
  returns: v.bytes(),
  handler: async (ctx, a): Promise<ArrayBuffer> => {
    const storageId = await ctx.runQuery(internal.workflows.fileFor, a);
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("404: file not found");
    return await blob.arrayBuffer();
  },
});

export const fileFor = internalQuery({
  args: { runId: v.id("runs"), name: v.string() },
  returns: v.id("_storage"),
  handler: async (ctx, { runId, name }) => {
    await requireRun(ctx, runId);
    const result = await ctx.db.query("runResults").withIndex("by_run", (q) => q.eq("runId", runId)).first();
    const file = result?.files.find((f) => f.name === name);
    if (!file) throw new Error("404: file not found");
    return file.storageId;
  },
});

/** Every run and conversation on a matter, newest first: the matter's history. */
const historyItem = v.object({
  type: v.union(v.literal("run"), v.literal("thread")), _id: v.string(), kind: v.string(), title: v.string(), status: v.optional(v.string()),
  at: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()), createdBy: v.string(), reviewId: v.optional(v.id("reviews")),
  matterId: v.id("matters"), matterName: v.string(),
});

async function historyOf(ctx: QueryCtx, matter: Doc<"matters">, take: number) {
  const runs = await ctx.db.query("runs").withIndex("by_matter", (q) => q.eq("matterId", matter._id)).order("desc").take(take);
  const threads = await ctx.db.query("threads").withIndex("by_matter", (q) => q.eq("matterId", matter._id)).order("desc").take(take);
  const m = { matterId: matter._id, matterName: matter.name };
  return [
    ...runs.map((r) => ({
      type: "run" as const, _id: r._id as string, kind: r.kind, title: r.title, status: r.status, at: r._creationTime,
      startedAt: r.startedAt, finishedAt: r.finishedAt, createdBy: r.createdBy, reviewId: r.reviewId, ...m,
    })),
    ...threads.map((t) => ({
      type: "thread" as const, _id: t._id as string, kind: "thread", title: t.title, status: undefined, at: t.lastMessageAt,
      startedAt: undefined, finishedAt: undefined, createdBy: t.createdBy, reviewId: undefined, ...m,
    })),
  ].sort((a, b) => b.at - a.at);
}

/** Every run and conversation on one matter, newest first. null when the caller may not see the matter. */
export const history = query({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.array(historyItem)),
  handler: async (ctx, { matterId }) => {
    try {
      const { matter } = await requireMatterAccess(ctx, matterId);
      return await historyOf(ctx, matter, 100);
    } catch {
      return null;
    }
  },
});

/** The firm's history across every matter the caller may see (admins: all), newest first. */
export const firmHistory = query({
  args: { firmId: v.id("firms"), limit: v.optional(v.number()) },
  returns: v.array(historyItem),
  handler: async (ctx, { firmId, limit }) => {
    const { userId, role } = await requireFirm(ctx, firmId);
    const n = Math.min(limit ?? 100, 200);
    // ponytail: per-matter scan, fine to a few hundred matters; add a by_firm index on runs if a firm outgrows it.
    const matters = await ctx.db.query("matters").withIndex("by_firm_updatedAt", (q) => q.eq("firmId", firmId)).order("desc").take(300);
    const out = [];
    for (const m of matters) if (await canSeeMatter(ctx, m, userId, role)) out.push(...(await historyOf(ctx, m, n)));
    return out.sort((a, b) => b.at - a.at).slice(0, n);
  },
});

// Operator entry points (seed and eval scripts, admin key only): the same code paths, acting as the firm's owner.
export const startContractReviewAsOwner = internalMutation({
  args: contractArgs, returns: v.id("runs"), handler: async (ctx, a) => contractReviewFor(ctx, await asOwner(ctx, a.matterId), a),
});
export const startDiligenceAsOwner = internalMutation({
  args: diligenceArgs, returns: v.id("runs"), handler: async (ctx, a) => diligenceFor(ctx, await asOwner(ctx, a.matterId), a),
});
export const startDraftAsOwner = internalMutation({
  args: draftArgs, returns: v.id("runs"), handler: async (ctx, a) => draftFor(ctx, await asOwner(ctx, a.matterId), a),
});
