// Operator entry points for scripts/seed-demo.ts and the eval runner. Internal
// functions only: they run with the deployment admin key, never from a browser.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { insertDocument } from "./documents";
import { MATTERS_ROOT } from "./matters";
import { party } from "./schema";

export const firm = internalQuery({
  args: { firmId: v.optional(v.id("firms")) },
  returns: v.union(v.null(), v.object({ _id: v.id("firms"), name: v.string(), status: v.string(), kitVersion: v.optional(v.string()) })),
  handler: async (ctx, { firmId }) => {
    const f = firmId ? await ctx.db.get(firmId) : await ctx.db.query("firms").filter((q) => q.eq(q.field("status"), "ready")).first();
    return f ? { _id: f._id, name: f.name, status: f.status, kitVersion: f.kitVersion } : null;
  },
});

/** The matter with this name in the firm, created when missing. */
export const matter = internalMutation({
  args: { firmId: v.id("firms"), name: v.string(), client: v.string(), parties: v.array(party), practiceArea: v.optional(v.string()) },
  returns: v.id("matters"),
  handler: async (ctx, a) => {
    const firm = await ctx.db.get(a.firmId);
    if (!firm) throw new Error("404: firm not found");
    const existing = await ctx.db
      .query("matters")
      .withIndex("by_firm_updatedAt", (q) => q.eq("firmId", a.firmId))
      .filter((q) => q.eq(q.field("name"), a.name))
      .first();
    if (existing) return existing._id;
    const matterId = await ctx.db.insert("matters", {
      firmId: a.firmId, name: a.name, client: a.client, parties: a.parties, practiceArea: a.practiceArea, status: "open",
      visibility: "firm", driveFolder: "", createdBy: firm.createdBy, updatedAt: Date.now(),
    });
    await ctx.db.patch(matterId, { driveFolder: `${MATTERS_ROOT}/${matterId}` });
    return matterId;
  },
});

export const uploadUrl = internalMutation({ args: {}, returns: v.string(), handler: async (ctx) => ctx.storage.generateUploadUrl() });

/** Add an uploaded file unless the matter already has a document with this name. A failed one is replaced. */
export const addDocument = internalMutation({
  args: { matterId: v.id("matters"), storageId: v.id("_storage"), filename: v.string() },
  returns: v.id("documents"),
  handler: async (ctx, a) => {
    const matter = await ctx.db.get(a.matterId);
    const firm = matter && (await ctx.db.get(matter.firmId));
    if (!matter || !firm) throw new Error("404: matter not found");
    const named = (await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", a.matterId)).collect())
      .filter((d) => d.filename === a.filename);
    for (const d of named.filter((d) => d.status === "failed")) {
      await ctx.storage.delete(d.storageId).catch(() => undefined);
      await ctx.db.delete(d._id);
    }
    const same = named.find((d) => d.status !== "failed");
    if (same) {
      await ctx.storage.delete(a.storageId);
      return same._id;
    }
    return await insertDocument(ctx, { firm, matter, userId: firm.createdBy, storageId: a.storageId, filename: a.filename });
  },
});

export const documents = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.array(v.object({ _id: v.id("documents"), filename: v.string(), status: v.string(), pages: v.optional(v.number()), paras: v.optional(v.number()) })),
  handler: async (ctx, { matterId }) =>
    (await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", matterId)).collect()).map((d) => ({
      _id: d._id, filename: d.filename, status: d.status, pages: d.pages, paras: d.paras,
    })),
});

/** What the eval scorer reads: each run's status, review cells and answer, with filenames and citation outcomes. */
export const results = internalQuery({
  args: { runIds: v.array(v.id("runs")) },
  returns: v.any(),
  handler: async (ctx, { runIds }) => {
    const out = [];
    for (const runId of runIds) {
      const run = await ctx.db.get(runId);
      if (!run) continue;
      const names = new Map<string, string>();
      for (const id of run.documentIds) names.set(id, (await ctx.db.get(id))?.filename ?? id);
      const cite = (c: { documentId: string; status: string }) => ({ filename: names.get(c.documentId) ?? c.documentId, status: c.status });
      const cells = run.reviewId
        ? (await ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", run.reviewId!)).collect()).map((c) => ({
            filename: names.get(c.documentId) ?? c.documentId, columnKey: c.columnKey, state: c.state, value: c.value ?? null,
            citations: c.citations.map(cite),
          }))
        : [];
      const answer = await ctx.db.query("answers").withIndex("by_run", (q) => q.eq("runId", runId)).first();
      const batches = await ctx.db.query("runBatches").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
      out.push({
        runId, kind: run.kind, status: run.status, question: run.question ?? null, startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null,
        attempts: batches.map((b) => b.attempts), cells,
        answer: answer ? { addressed: answer.addressed, answerMd: answer.answerMd, citations: answer.citations.map(cite) } : null,
      });
    }
    return out;
  },
});
