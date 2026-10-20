// Tabular reviews: rows = documents, columns = questions. A review outlives its
// runs: the first run fills every column, a `column` run fills columns added
// later or re-runs one. Verified and edited cells are human work: no run
// overwrites them (the new AI answer is kept beside them as aiValue).

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { requireMatterAccess } from "./access";
import { audit } from "./audit";
import { type Actor, checkColumns, createRun, readyDocs, startReviewFor } from "./runs";
import { cellState, column, runStatus } from "./schema";

const ACTIVE = new Set(["queued", "preparing", "running", "finalizing"]);

async function requireReview(ctx: QueryCtx, reviewId: Id<"reviews">) {
  const review = await ctx.db.get(reviewId);
  if (!review) throw new Error("404: review not found");
  return { review, ...(await requireMatterAccess(ctx, review.matterId)) };
}

const cellsOf = (ctx: QueryCtx, reviewId: Id<"reviews">) =>
  ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", reviewId)).collect();

const runsOf = async (ctx: QueryCtx, review: Doc<"reviews">) =>
  (await ctx.db.query("runs").withIndex("by_matter", (q) => q.eq("matterId", review.matterId)).order("desc").take(200))
    .filter((r) => r.reviewId === review._id);

export const listForMatter = query({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.array(v.object({
    _id: v.id("reviews"), _creationTime: v.number(), title: v.string(), documentCount: v.number(), columnCount: v.number(),
    filled: v.number(), cells: v.number(), lastRunStatus: v.optional(runStatus), diligence: v.boolean(),
  }))),
  handler: async (ctx, { matterId }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return null;
    }
    const reviews = await ctx.db.query("reviews").withIndex("by_matter", (q) => q.eq("matterId", matterId)).order("desc").take(100);
    return await Promise.all(reviews.map(async (r) => {
      const cells = await cellsOf(ctx, r._id);
      const runs = await runsOf(ctx, r);
      return {
        _id: r._id, _creationTime: r._creationTime, title: r.title, documentCount: r.documentIds.length, columnCount: r.columns.length,
        filled: cells.filter((c) => c.state !== "pending").length, cells: cells.length, lastRunStatus: runs[0]?.status,
        diligence: runs.some((x) => x.kind === "diligence"),
      };
    }));
  },
});

/** One review: the grid (effective values: edited ?? AI), each cell's review state, and the run that is filling it now. */
export const get = query({
  args: { reviewId: v.id("reviews") },
  returns: v.union(v.null(), v.object({
    review: v.object({ _id: v.id("reviews"), title: v.string(), matterId: v.id("matters"), createdBy: v.string(), _creationTime: v.number() }),
    columns: v.array(column),
    documents: v.array(v.object({ _id: v.id("documents"), filename: v.string() })),
    cells: v.array(v.object({
      documentId: v.id("documents"), columnKey: v.string(), state: cellState, value: v.optional(v.any()), aiValue: v.optional(v.any()),
      edited: v.boolean(), reviewStatus: v.union(v.literal("none"), v.literal("verified"), v.literal("flagged")),
      note: v.optional(v.string()), confidence: v.optional(v.string()),
      citations: v.array(v.object({
        documentId: v.id("documents"), filename: v.string(), page: v.number(), para: v.number(), quote: v.string(),
        status: v.union(v.literal("verified"), v.literal("relocated"), v.literal("unverified")), text: v.string(),
      })),
    })),
    runs: v.array(v.object({ _id: v.id("runs"), kind: v.string(), status: runStatus, title: v.string(), columnKeys: v.optional(v.array(v.string())),
      startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()), _creationTime: v.number() })),
  })),
  handler: async (ctx, { reviewId }) => {
    let review: Doc<"reviews">;
    try {
      review = (await requireReview(ctx, reviewId)).review;
    } catch {
      return null;
    }
    const docs = await Promise.all(review.documentIds.map((id) => ctx.db.get(id)));
    const names = new Map(docs.filter(Boolean).map((d) => [d!._id as string, d!.filename]));
    const paraCache = new Map<string, string>();
    const paraText = async (documentId: Id<"documents">, para: number) => {
      const k = `${documentId}:${para}`;
      if (!paraCache.has(k)) {
        const p = await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId).eq("para", para)).unique();
        paraCache.set(k, p?.text ?? "");
      }
      return paraCache.get(k)!;
    };
    const cells = await cellsOf(ctx, reviewId);
    const runs = await runsOf(ctx, review);
    return {
      review: { _id: review._id, title: review.title, matterId: review.matterId, createdBy: review.createdBy, _creationTime: review._creationTime },
      columns: review.columns,
      documents: review.documentIds.map((id) => ({ _id: id, filename: names.get(id) ?? "Document" })),
      cells: await Promise.all(cells.map(async (c) => ({
        documentId: c.documentId, columnKey: c.columnKey, state: c.state, value: c.editedValue ?? c.value, aiValue: c.aiValue,
        edited: c.editedValue !== undefined, reviewStatus: c.reviewStatus, note: c.note, confidence: c.confidence,
        citations: await Promise.all(c.citations.map(async (x) => ({
          ...x, filename: names.get(x.documentId) ?? "Document", text: await paraText(x.documentId, x.para),
        }))),
      }))),
      runs: runs.slice(0, 20).map((r) => ({
        _id: r._id, kind: r.kind, status: r.status, title: r.title, columnKeys: r.columnKeys, startedAt: r.startedAt, finishedAt: r.finishedAt,
        _creationTime: r._creationTime,
      })),
    };
  },
});

/** Start a review: one row per chosen document, one column per question (default: the commercial preset). */
export const create = mutation({
  args: { matterId: v.id("matters"), title: v.optional(v.string()), documentIds: v.optional(v.array(v.id("documents"))), columns: v.optional(v.array(column)) },
  returns: v.object({ reviewId: v.id("reviews"), runId: v.id("runs") }),
  handler: async (ctx, a) => {
    return await startReviewFor(ctx, await requireMatterAccess(ctx, a.matterId), a);
  },
});

async function noActiveRun(ctx: QueryCtx, review: Doc<"reviews">) {
  if ((await runsOf(ctx, review)).some((r) => ACTIVE.has(r.status))) throw new Error("409: a run is still filling this review; wait for it or cancel it");
}

async function columnRun(ctx: MutationCtx, actor: Actor, review: Doc<"reviews">, keys: string[], title: string) {
  const docs = await readyDocs(ctx, review.matterId, undefined);
  const inReview = docs.filter((d) => review.documentIds.includes(d._id));
  return await createRun(ctx, { ...actor, kind: "column", title, docs: inReview, reviewId: review._id, columnKeys: keys });
}

/** Add columns to a review: only the new columns run, on the existing rows. */
export const addColumns = mutation({
  args: { reviewId: v.id("reviews"), columns: v.array(column) },
  returns: v.id("runs"),
  handler: async (ctx, { reviewId, columns }) => {
    const { review, ...actor } = await requireReview(ctx, reviewId);
    await noActiveRun(ctx, review);
    const added = checkColumns(columns);
    const all = checkColumns([...review.columns, ...added]);
    await ctx.db.patch(reviewId, { columns: all });
    for (const id of review.documentIds) {
      for (const c of added) {
        await ctx.db.insert("reviewCells", { reviewId, documentId: id, columnKey: c.key, state: "pending", citations: [], reviewStatus: "none" });
      }
    }
    return await columnRun(ctx, actor, { ...review, columns: all }, added.map((c) => c.key),
      `${review.title}: ${added.map((c) => c.label).join(", ")}`.slice(0, 120));
  },
});

/** Run one column again. Verified and edited cells keep their value; the new AI answer is shown beside them. */
export const rerunColumn = mutation({
  args: { reviewId: v.id("reviews"), columnKey: v.string() },
  returns: v.id("runs"),
  handler: async (ctx, { reviewId, columnKey }) => {
    const { review, ...actor } = await requireReview(ctx, reviewId);
    await noActiveRun(ctx, review);
    const col = review.columns.find((c) => c.key === columnKey);
    if (!col) throw new Error("404: no such column");
    for (const c of await cellsOf(ctx, reviewId)) {
      if (c.columnKey !== columnKey || c.reviewStatus === "verified" || c.editedValue !== undefined) continue;
      await ctx.db.patch(c._id, { state: "pending", value: undefined, note: undefined, confidence: undefined, citations: [], aiValue: undefined });
    }
    return await columnRun(ctx, actor, review, [columnKey], `${review.title}: ${col.label} (re-run)`.slice(0, 120));
  },
});

/** A lawyer's decision on one cell: verify, flag, clear, edit the value, or accept the newer AI answer. Every one is audited. */
export const setCell = mutation({
  args: {
    reviewId: v.id("reviews"), documentId: v.id("documents"), columnKey: v.string(),
    action: v.union(v.literal("verify"), v.literal("flag"), v.literal("clear"), v.literal("edit"), v.literal("revert"), v.literal("accept_ai")),
    value: v.optional(v.union(v.string(), v.boolean(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { review, firm, userId } = await requireReview(ctx, a.reviewId);
    const cell = await ctx.db
      .query("reviewCells")
      .withIndex("by_review_doc_col", (q) => q.eq("reviewId", a.reviewId).eq("documentId", a.documentId).eq("columnKey", a.columnKey))
      .unique();
    if (!cell) throw new Error("404: no such cell");
    if (cell.state === "pending") throw new Error("409: the cell is still being filled");
    const doc = await ctx.db.get(a.documentId);
    const label = review.columns.find((c) => c.key === a.columnKey)?.label ?? a.columnKey;
    const where = `${review.title} / ${doc?.filename ?? "document"} / ${label}`;
    if (a.action === "verify" || a.action === "flag" || a.action === "clear") {
      await ctx.db.patch(cell._id, { reviewStatus: a.action === "clear" ? "none" : a.action === "verify" ? "verified" : "flagged" });
      if (a.action !== "clear") await audit(ctx, { firm, actorId: userId, action: a.action === "verify" ? "cell.verify" : "cell.flag", matterId: review.matterId, detail: where });
      return null;
    }
    if (a.action === "edit") {
      if (a.value === undefined) throw new Error("400: a value is required");
      const value = typeof a.value === "string" ? a.value.trim().slice(0, 2000) : a.value;
      await ctx.db.patch(cell._id, { editedValue: value, editedBy: userId });
      await audit(ctx, { firm, actorId: userId, action: "cell.edit", matterId: review.matterId, detail: `${where}: ${String(value).slice(0, 120)}` });
      return null;
    }
    if (a.action === "accept_ai") {
      if (cell.aiValue === undefined) return null;
      await ctx.db.patch(cell._id, { value: cell.aiValue, aiValue: undefined, editedValue: undefined, editedBy: undefined, reviewStatus: "none" });
      await audit(ctx, { firm, actorId: userId, action: "cell.edit", matterId: review.matterId, detail: `${where}: accepted the newer AI answer` });
      return null;
    }
    await ctx.db.patch(cell._id, { editedValue: undefined, editedBy: undefined });
    await audit(ctx, { firm, actorId: userId, action: "cell.edit", matterId: review.matterId, detail: `${where}: back to the AI answer` });
    return null;
  },
});
