// Lumen's orchestration engine: the state, in Convex. A run is one user-visible
// job; it fans out into batches (one Kortix session each, ≤ 4 documents). The
// node actions in convex/engine.ts launch and poll the sessions; every state
// change goes through a mutation here and writes a runEvents row, which is the
// progress stream the run screen subscribes to.
//
// Run:   queued → preparing → running → succeeded | partial | failed   (any → canceled)
// Batch: pending → starting → working → succeeded | failed            (any → canceled)

import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireMatterAccess } from "./access";
import { audit } from "./audit";
import { type Citation, verifyCitation } from "./lib/cite";
import { DD_COLUMNS, PRESET_COLUMNS } from "./lib/columns";
import { templateFields } from "./lib/template";
import { COUNSEL_ROLE, DRAFTER_ROLE, EXTRACTOR_ROLE, REVIEWER_ROLE } from "./lumenAgent";
import { batchStatus, cellState, checkedCitation, column, runKind, runStatus, severity } from "./schema";

export const DOCS_PER_BATCH = 4;
export const MAX_RUNNING_PER_RUN = 4;
export const MAX_RUNNING_PER_FIRM = 8;
export const LIMITS = { repair: 2, nudge: 2, relaunch: 1 };
export const NO_PROGRESS_MS = 20 * 60_000;
export const RUN_TIMEOUT_MS = 60 * 60_000;

type Column = Infer<typeof column>;

export { DD_COLUMNS, PRESET_COLUMNS };

const TERMINAL_RUN = new Set(["succeeded", "partial", "failed", "canceled"]);
const TERMINAL_BATCH = new Set(["succeeded", "failed", "canceled"]);
const RUNNING_BATCH = ["starting", "working", "validating"] as const;

async function event(ctx: MutationCtx, runId: Id<"runs">, type: string, detail?: string, batchId?: Id<"runBatches">) {
  await ctx.db.insert("runEvents", { runId, batchId, at: Date.now(), type, detail: detail?.slice(0, 500) });
}

/** The ready documents of a matter, or the listed ones (each must be ready and in the matter). */
async function readyDocs(ctx: QueryCtx, matterId: Id<"matters">, ids: Id<"documents">[] | undefined) {
  const all = await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", matterId)).collect();
  const ready = all.filter((d) => d.status === "ready" && (d.paras ?? 0) > 0).sort((a, b) => a._creationTime - b._creationTime);
  // By default new work reads the latest version of each document; an explicit pick may name an earlier one.
  if (!ids) return ready.filter((d) => !d.superseded);
  const picked = ids.map((id) => ready.find((d) => d._id === id));
  if (picked.some((d) => !d)) throw new Error("400: every document must be ready and in this matter");
  return picked as Doc<"documents">[];
}

type RunKind = Infer<typeof runKind>;
type RunInput = {
  matter: Doc<"matters">; firm: Doc<"firms">; userId: string; kind: RunKind; title: string; docs: Doc<"documents">[];
  reviewId?: Id<"reviews">; question?: string; columnKeys?: string[]; libraryItemId?: Id<"libraryItems">; perspective?: string;
  fields?: Record<string, string>;
};

/** The kit role and the batches each kind runs as (every role runs on the firm's one agent). A draft may have no source documents; every other kind needs one. */
function plan(a: RunInput): Array<{ role: string; docs: Doc<"documents">[]; phase?: "map" | "reduce" }> {
  switch (a.kind) {
    case "ask":
      return [{ role: COUNSEL_ROLE, docs: a.docs }];
    case "contract_review":
      return [{ role: REVIEWER_ROLE, docs: a.docs }];
    case "draft":
      return [{ role: DRAFTER_ROLE, docs: a.docs }];
    case "diligence":
      return [
        ...chunk(a.docs, DOCS_PER_BATCH).map((docs) => ({ role: EXTRACTOR_ROLE, docs, phase: "map" as const })),
        { role: COUNSEL_ROLE, docs: a.docs, phase: "reduce" },
      ];
    default:
      return chunk(a.docs, DOCS_PER_BATCH).map((docs) => ({ role: EXTRACTOR_ROLE, docs }));
  }
}

export async function createRun(ctx: MutationCtx, a: RunInput) {
  if (a.docs.length === 0 && a.kind !== "draft") throw new Error("400: add documents to the vault first");
  const runId = await ctx.db.insert("runs", {
    firmId: a.firm._id, matterId: a.matter._id, kind: a.kind, title: a.title, status: "queued", reviewId: a.reviewId,
    question: a.question, columnKeys: a.columnKeys, libraryItemId: a.libraryItemId, perspective: a.perspective, fields: a.fields,
    documentIds: a.docs.map((d) => d._id), createdBy: a.userId,
  });
  const batches = plan(a);
  for (const [index, b] of batches.entries()) {
    await ctx.db.insert("runBatches", {
      runId, firmId: a.firm._id, index, role: b.role, phase: b.phase, status: "pending",
      documentIds: b.docs.map((d) => d._id), attempts: { repair: 0, nudge: 0, relaunch: 0 },
    });
  }
  const n = batches.length;
  await event(ctx, runId, "queued", `${a.docs.length} document${a.docs.length === 1 ? "" : "s"} in ${n} batch${n === 1 ? "" : "es"}`);
  await audit(ctx, { firm: a.firm, actorId: a.userId, action: "run.start", matterId: a.matter._id, detail: `${a.kind}: ${a.title}` });
  await ctx.scheduler.runAfter(0, internal.engine.prepare, { runId });
  return runId;
}

/** The result schema a batch writes, and the file the batch owes when it writes one file. */
export function resultContract(kind: RunKind, phase: "map" | "reduce" | undefined): { schema: string; file?: string } {
  if (kind === "ask") return { schema: "answer", file: "out/answer.json" };
  if (kind === "contract_review") return { schema: "issues", file: "out/issues.json" };
  if (kind === "draft") return { schema: "draft", file: "out/draft.json" };
  if (kind === "diligence" && phase === "reduce") return { schema: "diligence-report", file: "out/report.json" };
  return { schema: "review-row" };
}

/** What a batch's input.json calls its kind. */
export function inputKind(kind: RunKind, phase: "map" | "reduce" | undefined) {
  return kind === "diligence" ? (phase === "reduce" ? "diligence_reduce" : "diligence_map") : kind;
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Actor = { matter: Doc<"matters">; firm: Doc<"firms">; userId: string };
export type { Actor };
export { readyDocs };
const reviewArgs = {
  matterId: v.id("matters"),
  title: v.optional(v.string()),
  documentIds: v.optional(v.array(v.id("documents"))),
  columns: v.optional(v.array(column)),
};
const askArgs = { matterId: v.id("matters"), question: v.string(), documentIds: v.optional(v.array(v.id("documents"))) };

/** A review and its pending cells: one row per document, one column per question (default: the commercial preset). */
export async function createReview(
  ctx: MutationCtx, { matter, firm, userId }: Actor, a: { title?: string; documentIds?: Id<"documents">[]; columns?: Column[] },
) {
  const docs = await readyDocs(ctx, matter._id, a.documentIds);
  if (docs.length === 0) throw new Error("400: add documents to the vault first");
  const columns = checkColumns(a.columns ?? PRESET_COLUMNS);
  const title = a.title?.trim().slice(0, 120) || "Commercial contract basics";
  const reviewId = await ctx.db.insert("reviews", {
    firmId: firm._id, matterId: matter._id, title, documentIds: docs.map((d) => d._id), columns, createdBy: userId,
  });
  for (const d of docs) {
    for (const c of columns) {
      await ctx.db.insert("reviewCells", { reviewId, documentId: d._id, columnKey: c.key, state: "pending", citations: [], reviewStatus: "none" });
    }
  }
  return { reviewId, docs, title };
}

export async function startReviewFor(ctx: MutationCtx, actor: Actor, a: { title?: string; documentIds?: Id<"documents">[]; columns?: Column[] }) {
  const { reviewId, docs, title } = await createReview(ctx, actor, a);
  const runId = await createRun(ctx, { ...actor, kind: "review", title, docs, reviewId });
  return { runId, reviewId };
}

/** 1-20 columns with distinct lower_snake_case keys, labels and questions; a tag column lists its options. */
export function checkColumns(columns: Column[]): Column[] {
  if (columns.length === 0 || columns.length > 20 || new Set(columns.map((c) => c.key)).size !== columns.length) {
    throw new Error("400: 1-20 columns with distinct keys");
  }
  if (columns.some((c) => !/^[a-z][a-z0-9_]{0,39}$/.test(c.key))) throw new Error("400: column keys are lower_snake_case");
  return columns.map((c) => {
    const label = c.label.trim().slice(0, 60);
    const prompt = c.prompt.trim().slice(0, 500);
    if (!label || prompt.length < 3) throw new Error("400: every column needs a label and a question");
    const options = c.options?.map((o) => o.trim()).filter(Boolean).slice(0, 20);
    if (c.format === "tag" && !options?.length) throw new Error(`400: the tag column "${label}" needs options`);
    return { key: c.key, label, prompt, format: c.format, ...(c.format === "tag" ? { options } : {}) };
  });
}

async function askFor(ctx: MutationCtx, { matter, firm, userId }: Actor, a: { question: string; documentIds?: Id<"documents">[] }) {
  const question = a.question.trim().replace(/\s+/g, " ");
  if (question.length < 3 || question.length > 1000) throw new Error("400: a question of 3-1000 characters");
  const docs = await readyDocs(ctx, matter._id, a.documentIds);
  return await createRun(ctx, { matter, firm, userId, kind: "ask", title: question.slice(0, 120), docs, question });
}

/** Start a tabular review: one row per document, one column per question (default: the commercial preset). */
export const startReview = mutation({
  args: reviewArgs,
  returns: v.object({ runId: v.id("runs"), reviewId: v.id("reviews") }),
  handler: async (ctx, a) => startReviewFor(ctx, await requireMatterAccess(ctx, a.matterId), a),
});

/** Ask one question across the vault: a structured, citation-checked answer. */
export const ask = mutation({
  args: askArgs,
  returns: v.id("runs"),
  handler: async (ctx, a) => askFor(ctx, await requireMatterAccess(ctx, a.matterId), a),
});

/** The operator's entry points (seed and eval scripts, admin key only): the same code path, acting as the firm's owner. */
export async function asOwner(ctx: MutationCtx, matterId: Id<"matters">): Promise<Actor> {
  const matter = await ctx.db.get(matterId);
  const firm = matter && (await ctx.db.get(matter.firmId));
  if (!matter || !firm) throw new Error("404: matter not found");
  return { matter, firm, userId: firm.createdBy };
}
export const startReviewAsOwner = internalMutation({
  args: reviewArgs,
  returns: v.object({ runId: v.id("runs"), reviewId: v.id("reviews") }),
  handler: async (ctx, a) => startReviewFor(ctx, await asOwner(ctx, a.matterId), a),
});
export const askAsOwner = internalMutation({
  args: askArgs,
  returns: v.id("runs"),
  handler: async (ctx, a) => askFor(ctx, await asOwner(ctx, a.matterId), a),
});

export async function requireRun(ctx: QueryCtx, runId: Id<"runs">) {
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("404: run not found");
  return { run, ...(await requireMatterAccess(ctx, run.matterId)) };
}

export const cancel = mutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const { run, firm, userId } = await requireRun(ctx, runId);
    if (TERMINAL_RUN.has(run.status)) return null;
    await ctx.db.patch(runId, { status: "canceled", finishedAt: Date.now() });
    const sessions: string[] = [];
    for (const b of await batchesOf(ctx, runId)) {
      if (TERMINAL_BATCH.has(b.status)) continue;
      await ctx.db.patch(b._id, { status: "canceled", finishedAt: Date.now() });
      if (b.kortixSessionId) sessions.push(b.kortixSessionId);
    }
    await event(ctx, runId, "canceled", "Canceled by a member");
    await audit(ctx, { firm, actorId: userId, action: "run.cancel", matterId: run.matterId, detail: run.title });
    if (sessions.length) await ctx.scheduler.runAfter(0, internal.engine.stopSessions, { runId, sessions });
    await wakeFirm(ctx, run.firmId);
    return null;
  },
});

/** Run the failed batches of a partial or failed run again, with fresh attempt budgets. */
export const retryFailed = mutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const { run } = await requireRun(ctx, runId);
    if (run.status !== "partial" && run.status !== "failed") return null;
    let n = 0;
    for (const b of await batchesOf(ctx, runId)) {
      if (b.status !== "failed") continue;
      await ctx.db.patch(b._id, {
        status: "pending", error: undefined, kortixSessionId: undefined, attempts: { repair: 0, nudge: 0, relaunch: 0 },
        startedAt: undefined, finishedAt: undefined, lastProgressAt: undefined, lastPromptAt: undefined,
      });
      n++;
    }
    if (!n) return null;
    await ctx.db.patch(runId, { status: "queued", error: undefined, finishedAt: undefined });
    await event(ctx, runId, "retry", `${n} failed batch${n === 1 ? "" : "es"} queued again`);
    await ctx.scheduler.runAfter(0, internal.engine.prepare, { runId });
    return null;
  },
});

const batchesOf = (ctx: QueryCtx, runId: Id<"runs">) => ctx.db.query("runBatches").withIndex("by_run", (q) => q.eq("runId", runId)).collect();

// ── queries for the run screen ──

const runRow = v.object({
  _id: v.id("runs"),
  _creationTime: v.number(),
  kind: runKind,
  title: v.string(),
  status: runStatus,
  reviewId: v.optional(v.id("reviews")),
  documentCount: v.number(),
  batchesDone: v.number(),
  batchCount: v.number(),
  startedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  createdBy: v.string(),
});

async function rowOf(ctx: QueryCtx, r: Doc<"runs">) {
  const batches = await batchesOf(ctx, r._id);
  return {
    _id: r._id, _creationTime: r._creationTime, kind: r.kind, title: r.title, status: r.status, reviewId: r.reviewId,
    documentCount: r.documentIds.length, batchesDone: batches.filter((b) => TERMINAL_BATCH.has(b.status)).length, batchCount: batches.length,
    startedAt: r.startedAt, finishedAt: r.finishedAt, createdBy: r.createdBy,
  };
}

export const listForMatter = query({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.array(runRow)),
  handler: async (ctx, { matterId }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return null;
    }
    const runs = await ctx.db.query("runs").withIndex("by_matter", (q) => q.eq("matterId", matterId)).order("desc").take(50);
    return await Promise.all(runs.map((r) => rowOf(ctx, r)));
  },
});

const citationView = v.object({
  documentId: v.id("documents"), filename: v.string(), page: v.number(), para: v.number(), quote: v.string(),
  status: v.union(v.literal("verified"), v.literal("relocated"), v.literal("unverified")), text: v.string(),
});

/** One run: batches, the event log, and its results (review cells or the answer), citations with their source paragraph. */
export const get = query({
  // A string, not v.id: a malformed link must show "not found", not throw.
  args: { runId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      run: runRow,
      error: v.optional(v.string()),
      question: v.optional(v.string()),
      batches: v.array(v.object({
        _id: v.id("runBatches"), index: v.number(), phase: v.optional(v.string()), status: batchStatus, documentCount: v.number(), error: v.optional(v.string()),
        attempts: v.object({ repair: v.number(), nudge: v.number(), relaunch: v.number() }), startedAt: v.optional(v.number()),
        finishedAt: v.optional(v.number()),
      })),
      events: v.array(v.object({ at: v.number(), type: v.string(), detail: v.optional(v.string()), batchIndex: v.optional(v.number()) })),
      documents: v.array(v.object({ _id: v.id("documents"), filename: v.string() })),
      columns: v.array(column),
      cells: v.array(v.object({
        documentId: v.id("documents"), columnKey: v.string(), state: cellState, value: v.optional(v.any()), note: v.optional(v.string()),
        confidence: v.optional(v.string()), citations: v.array(citationView),
      })),
      answer: v.union(v.null(), v.object({ addressed: v.boolean(), answerMd: v.string(), citations: v.array(citationView) })),
      issues: v.array(v.object({
        _id: v.id("issues"), ruleId: v.string(), title: v.string(), assessment: v.string(), severity, finding: v.string(),
        redline: v.optional(v.object({ a: v.string(), from: v.string(), to: v.string(), comment: v.string() })),
        citations: v.array(citationView), decision: v.union(v.literal("open"), v.literal("accepted"), v.literal("dismissed")),
      })),
      result: v.union(v.null(), v.object({
        kind: v.string(), title: v.optional(v.string()), summary: v.optional(v.string()), markdown: v.optional(v.string()),
        unfilled: v.optional(v.array(v.string())),
        sections: v.optional(v.array(v.object({ heading: v.string(), bodyMd: v.string(), citations: v.array(citationView) }))),
        redFlags: v.optional(v.array(v.object({
          title: v.string(), severity, filename: v.optional(v.string()), citations: v.array(citationView),
        }))),
        citations: v.optional(v.array(citationView)),
        files: v.array(v.object({ name: v.string(), bytes: v.number() })),
      })),
      libraryItem: v.union(v.null(), v.object({ name: v.string(), kind: v.string() })),
      perspective: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { runId: raw }) => {
    const runId = ctx.db.normalizeId("runs", raw);
    if (!runId) return null;
    let run: Doc<"runs">;
    try {
      run = (await requireRun(ctx, runId)).run;
    } catch {
      return null;
    }
    const batches = await batchesOf(ctx, runId);
    const indexOf = new Map(batches.map((b) => [b._id, b.index]));
    const events = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).order("desc").take(200);
    const docs = await Promise.all(run.documentIds.map((id) => ctx.db.get(id)));
    const names = new Map(docs.filter(Boolean).map((d) => [d!._id, d!.filename]));
    const paraText = async (c: Infer<typeof checkedCitation>) => {
      const p = await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", c.documentId).eq("para", c.para)).unique();
      return { ...c, filename: names.get(c.documentId) ?? "Document", text: p?.text ?? "" };
    };
    const review = run.reviewId ? await ctx.db.get(run.reviewId) : null;
    const cells = review
      ? await ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", review._id)).collect()
      : [];
    const answer = await ctx.db.query("answers").withIndex("by_run", (q) => q.eq("runId", runId)).first();
    const issues = await ctx.db.query("issues").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    const result = await ctx.db.query("runResults").withIndex("by_run", (q) => q.eq("runId", runId)).first();
    const item = run.libraryItemId ? await ctx.db.get(run.libraryItemId) : null;
    return {
      run: await rowOf(ctx, run),
      error: run.error,
      question: run.question,
      batches: batches.map((b) => ({
        _id: b._id, index: b.index, phase: b.phase, status: b.status, documentCount: b.documentIds.length, error: b.error, attempts: b.attempts,
        startedAt: b.startedAt, finishedAt: b.finishedAt,
      })),
      events: events.reverse().map((e) => ({ at: e.at, type: e.type, detail: e.detail, batchIndex: e.batchId ? indexOf.get(e.batchId) : undefined })),
      documents: run.documentIds.map((id) => ({ _id: id, filename: names.get(id) ?? "Document" })),
      columns: (review?.columns ?? []).filter((c) => !run.columnKeys || run.columnKeys.includes(c.key)),
      cells: await Promise.all(cells.map(async (c) => ({
        documentId: c.documentId, columnKey: c.columnKey, state: c.state, value: c.editedValue ?? c.value, note: c.note,
        confidence: c.confidence, citations: await Promise.all(c.citations.map(paraText)),
      }))),
      answer: answer ? { addressed: answer.addressed, answerMd: answer.answerMd, citations: await Promise.all(answer.citations.map(paraText)) } : null,
      issues: await Promise.all(issues.map(async (i) => ({
        _id: i._id, ruleId: i.ruleId, title: i.title, assessment: i.assessment, severity: i.severity, finding: i.finding, redline: i.redline,
        citations: await Promise.all(i.citations.map(paraText)), decision: i.decision,
      }))),
      result: result
        ? {
            kind: result.kind, title: result.title, summary: result.summary, markdown: result.markdown, unfilled: result.unfilled,
            sections: result.sections && await Promise.all(result.sections.map(async (x) => ({ ...x, citations: await Promise.all(x.citations.map(paraText)) }))),
            redFlags: result.redFlags && await Promise.all(result.redFlags.map(async (f) => ({
              title: f.title, severity: f.severity, filename: f.documentId ? names.get(f.documentId) : undefined,
              citations: await Promise.all(f.citations.map(paraText)),
            }))),
            citations: result.citations && await Promise.all(result.citations.map(paraText)),
            files: result.files.map((f) => ({ name: f.name, bytes: f.bytes })),
          }
        : null,
      libraryItem: item ? { name: item.name, kind: item.kind } : null,
      perspective: run.perspective,
    };
  },
});

// ── internal: the engine's state transitions ──

export const forPrepare = internalQuery({
  args: { runId: v.id("runs") },
  returns: v.any(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    const [firm, matter] = await Promise.all([ctx.db.get(run.firmId), ctx.db.get(run.matterId)]);
    const review = run.reviewId ? await ctx.db.get(run.reviewId) : null;
    const batches = await batchesOf(ctx, runId);
    const docs = await Promise.all(run.documentIds.map((id) => ctx.db.get(id)));
    const columns = review ? review.columns.filter((c) => !run.columnKeys || run.columnKeys.includes(c.key)) : null;
    const item = run.libraryItemId ? await ctx.db.get(run.libraryItemId) : null;
    return { run, firm, matter, columns, batches, docs: docs.filter(Boolean), library: item ? { name: item.name, body: item.body } : null };
  },
});

export const markRun = internalMutation({
  args: { runId: v.id("runs"), status: runStatus, error: v.optional(v.string()), kitVersion: v.optional(v.string()), detail: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { runId, status, error, kitVersion, detail }) => {
    const run = await ctx.db.get(runId);
    if (!run || TERMINAL_RUN.has(run.status)) return false;
    const now = Date.now();
    await ctx.db.patch(runId, {
      status, ...(error ? { error } : {}), ...(kitVersion ? { kitVersion } : {}),
      ...(status === "running" && !run.startedAt ? { startedAt: now } : {}), ...(TERMINAL_RUN.has(status) ? { finishedAt: now } : {}),
    });
    await event(ctx, runId, status, detail ?? error);
    if (status === "failed") {
      for (const b of await batchesOf(ctx, runId)) {
        if (!TERMINAL_BATCH.has(b.status)) await ctx.db.patch(b._id, { status: "failed", error: error ?? "The run failed", finishedAt: now });
      }
      await failPendingCells(ctx, run, run.documentIds);
    }
    return true;
  },
});

/** Start pending batches while the run has < 4 and the firm < 8 running. */
export const schedule = internalMutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return null;
    let firmRunning = 0;
    for (const s of RUNNING_BATCH) {
      firmRunning += (await ctx.db.query("runBatches").withIndex("by_firm_status", (q) => q.eq("firmId", run.firmId).eq("status", s)).collect()).length;
    }
    const batches = await batchesOf(ctx, runId);
    let runRunning = batches.filter((b) => (RUNNING_BATCH as readonly string[]).includes(b.status)).length;
    const maps = batches.filter((b) => b.phase === "map");
    const mapsDone = maps.every((b) => TERMINAL_BATCH.has(b.status));
    for (const b of batches) {
      if (b.status !== "pending") continue;
      if (b.phase === "reduce") {
        // The report needs the whole checklist: it waits for every map batch, and fails when none succeeded.
        if (!mapsDone) continue;
        if (!maps.some((m) => m.status === "succeeded")) {
          await ctx.scheduler.runAfter(0, internal.runs.settleBatch, { batchId: b._id, status: "failed", error: "No checklist rows to report on" });
          continue;
        }
      }
      if (runRunning >= MAX_RUNNING_PER_RUN || firmRunning >= MAX_RUNNING_PER_FIRM) break;
      await ctx.db.patch(b._id, { status: "starting" });
      await event(ctx, runId, "starting", b.phase === "reduce" ? "Report: starting a workspace" : `Batch ${b.index + 1}: starting a workspace`, b._id);
      await ctx.scheduler.runAfter(0, internal.engine.launch, { batchId: b._id });
      runRunning++;
      firmRunning++;
    }
    return null;
  },
});

export const batchContext = internalQuery({
  args: { batchId: v.id("runBatches") },
  returns: v.any(),
  handler: async (ctx, { batchId }) => {
    const batch = await ctx.db.get(batchId);
    if (!batch) return null;
    const run = await ctx.db.get(batch.runId);
    const firm = run && (await ctx.db.get(run.firmId));
    if (!run || !firm) return null;
    const files = await ctx.db.query("runFiles").withIndex("by_batch_path", (q) => q.eq("batchId", batchId)).collect();
    return { batch, run, firm, files: files.map((f) => ({ path: f.path, version: f.version, status: f.status })) };
  },
});

/** Patch a live batch and log the step. False when the batch is already terminal (the caller stops). */
export const updateBatch = internalMutation({
  args: {
    batchId: v.id("runBatches"),
    patch: v.object({
      status: v.optional(batchStatus),
      kortixSessionId: v.optional(v.string()),
      startedAt: v.optional(v.number()),
      lastProgressAt: v.optional(v.number()),
      lastPromptAt: v.optional(v.number()),
      attempts: v.optional(v.object({ repair: v.number(), nudge: v.number(), relaunch: v.number() })),
    }),
    event: v.optional(v.object({ type: v.string(), detail: v.optional(v.string()) })),
  },
  returns: v.boolean(),
  handler: async (ctx, { batchId, patch, event: e }) => {
    const b = await ctx.db.get(batchId);
    if (!b || TERMINAL_BATCH.has(b.status)) return false;
    await ctx.db.patch(batchId, patch);
    if (e) await event(ctx, b.runId, e.type, e.detail, batchId);
    return true;
  },
});

export const recordFile = internalMutation({
  args: { batchId: v.id("runBatches"), path: v.string(), version: v.string(), status: v.union(v.literal("accepted"), v.literal("rejected")),
    errors: v.optional(v.array(v.string())) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const old = await ctx.db.query("runFiles").withIndex("by_batch_path", (q) => q.eq("batchId", a.batchId).eq("path", a.path)).unique();
    const row = { batchId: a.batchId, path: a.path, version: a.version, status: a.status, errors: a.errors?.slice(0, 20) };
    if (old) await ctx.db.patch(old._id, row);
    else await ctx.db.insert("runFiles", row);
    return null;
  },
});

/** Check every citation against Lumen's own paragraphs. Unknown documents and unverifiable quotes are kept as unverified. */
async function checkCitations(ctx: MutationCtx, raw: Citation[], allowed: Set<string>) {
  const out: Infer<typeof checkedCitation>[] = [];
  const cache = new Map<string, Array<{ page: number; para: number; text: string }>>();
  for (const c of raw) {
    const documentId = ctx.db.normalizeId("documents", c.doc_id);
    if (!documentId || !allowed.has(documentId)) continue;
    if (!cache.has(documentId)) {
      cache.set(documentId, await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId)).collect());
    }
    const paras = cache.get(documentId)!;
    const r = verifyCitation(c, paras);
    const m = /^p(\d+)\.(\d+)$/.exec(r.a);
    const para = m ? Number(m[2]) : 0;
    out.push({ documentId, page: m ? Number(m[1]) : 0, para, quote: c.quote.slice(0, 300), status: r.status });
  }
  return { citations: out, dropped: raw.length - out.length };
}

type Checked = Infer<typeof checkedCitation>;
type Ctx = { run: Doc<"runs">; batch: Doc<"runBatches">; allowed: Set<string>; unverified: number };
const fileArg = v.object({ name: v.string(), storageId: v.id("_storage"), bytes: v.number() });

async function cite(ctx: MutationCtx, c: Ctx, raw: Citation[] | undefined): Promise<Checked[]> {
  const { citations, dropped } = await checkCitations(ctx, raw ?? [], c.allowed);
  c.unverified += dropped + citations.filter((x) => x.status === "unverified").length;
  return citations;
}

/** One review row: every column of the review (a column run: only its columns). Verified or edited cells keep their value. */
async function ingestRow(ctx: MutationCtx, c: Ctx, value: any, problems: string[]) {
  const review = c.run.reviewId && (await ctx.db.get(c.run.reviewId));
  const documentId = ctx.db.normalizeId("documents", value.doc_id);
  if (!review || !documentId || !c.allowed.has(documentId)) return void problems.push(`doc_id ${value.doc_id} is not a document of this batch`);
  const keys = new Set(c.run.columnKeys ?? review.columns.map((col) => col.key));
  for (const col of review.columns.filter((x) => keys.has(x.key))) {
    const cell = value.cells?.[col.key];
    const row = await ctx.db
      .query("reviewCells")
      .withIndex("by_review_doc_col", (q) => q.eq("reviewId", review._id).eq("documentId", documentId).eq("columnKey", col.key))
      .unique();
    if (!row) continue;
    if (!cell) {
      problems.push(`row ${value.doc_id}: no cell for column ${col.key}`);
      continue;
    }
    const citations = await cite(ctx, c, cell.citations);
    const supported = citations.some((x) => x.status !== "unverified");
    const state = cell.not_found ? "not_found" : supported ? "filled" : "needs_review";
    const human = row.reviewStatus === "verified" || row.editedValue !== undefined;
    await ctx.db.patch(row._id, {
      // A human-checked cell keeps its value and state; the new AI answer waits beside it.
      ...(human ? { aiValue: cell.value ?? null } : { state, value: cell.value, aiValue: undefined }),
      note: cell.note, confidence: cell.confidence, citations, runId: c.run._id,
    });
  }
  await event(ctx, c.run._id, "row", `Row ready: ${(await ctx.db.get(documentId))?.filename ?? value.doc_id}`, c.batch._id);
}

async function putResult(ctx: MutationCtx, run: Doc<"runs">, row: Omit<Doc<"runResults">, "_id" | "_creationTime">) {
  const old = await ctx.db.query("runResults").withIndex("by_run", (q) => q.eq("runId", run._id)).first();
  if (old) {
    for (const f of old.files) if (!row.files.some((n) => n.storageId === f.storageId)) await ctx.storage.delete(f.storageId).catch(() => undefined);
    await ctx.db.replace(old._id, row);
  } else await ctx.db.insert("runResults", row);
}

async function ingestIssues(ctx: MutationCtx, c: Ctx, value: any, files: Array<Infer<typeof fileArg>>) {
  const documentId = c.run.documentIds[0];
  for (const old of await ctx.db.query("issues").withIndex("by_run", (q) => q.eq("runId", c.run._id)).collect()) await ctx.db.delete(old._id);
  let order = 0;
  for (const i of value.issues as any[]) {
    await ctx.db.insert("issues", {
      runId: c.run._id, matterId: c.run.matterId, documentId, ruleId: String(i.rule_id).slice(0, 40), title: String(i.title).slice(0, 200),
      assessment: i.status, severity: i.severity, finding: String(i.finding).slice(0, 600), redline: i.redline ?? undefined,
      citations: await cite(ctx, c, i.citations), decision: "open", order: order++,
    });
  }
  for (const u of value.unmatched as any[]) {
    await ctx.db.insert("issues", {
      runId: c.run._id, matterId: c.run.matterId, documentId, ruleId: "unmatched", title: String(u.title).slice(0, 200),
      assessment: "unmatched", severity: "medium", finding: String(u.finding).slice(0, 600), citations: await cite(ctx, c, u.citations),
      decision: "open", order: order++,
    });
  }
  await putResult(ctx, c.run, { runId: c.run._id, matterId: c.run.matterId, kind: "issues", summary: String(value.summary).slice(0, 1200), files });
  const deviating = (value.issues as any[]).filter((i) => i.status !== "aligned").length;
  await event(ctx, c.run._id, "issues", `${deviating} of ${value.issues.length} rules need attention`, c.batch._id);
}

async function ingestReport(ctx: MutationCtx, c: Ctx, value: any, files: Array<Infer<typeof fileArg>>) {
  const sections = [];
  for (const s of value.sections as any[]) {
    sections.push({ heading: String(s.heading).slice(0, 120), bodyMd: String(s.body_md).slice(0, 8000), citations: await cite(ctx, c, s.citations) });
  }
  const redFlags = [];
  for (const f of value.red_flags as any[]) {
    const documentId = ctx.db.normalizeId("documents", f.doc_id);
    redFlags.push({
      title: String(f.title).slice(0, 200), severity: f.severity, documentId: documentId && c.allowed.has(documentId) ? documentId : undefined,
      citations: await cite(ctx, c, f.citations),
    });
  }
  await putResult(ctx, c.run, { runId: c.run._id, matterId: c.run.matterId, kind: "report", sections, redFlags, files });
  await event(ctx, c.run._id, "report", `Report ready: ${sections.length} sections, ${redFlags.length} red flags`, c.batch._id);
}

async function ingestDraft(ctx: MutationCtx, c: Ctx, value: any, files: Array<Infer<typeof fileArg>>, problems: string[]) {
  // With no source documents, a field the lawyer left empty has nowhere to come from: it must stay a [[CONFIRM]] marker.
  if (c.run.documentIds.length === 0 && c.run.libraryItemId) {
    const template = await ctx.db.get(c.run.libraryItemId);
    const given = new Set(Object.keys(c.run.fields ?? {}));
    const invented = templateFields(template?.body ?? "").filter((f) => !given.has(f) && !String(value.markdown).includes(`[[CONFIRM: ${f}]]`));
    if (invented.length) {
      problems.push(`out/draft.json: ${invented.join(", ")} ${invented.length === 1 ? "is" : "are"} not in "fields" and this draft has no source documents. Leave ${invented.length === 1 ? "it" : "them"} empty so the renderer writes [[CONFIRM: <field>]], render draft.docx again, and list ${invented.length === 1 ? "it" : "them"} in "unfilled".`);
      return;
    }
  }
  await putResult(ctx, c.run, {
    runId: c.run._id, matterId: c.run.matterId, kind: "draft", title: String(value.title).slice(0, 200),
    markdown: String(value.markdown).slice(0, 60_000), unfilled: (value.unfilled as string[]).slice(0, 40),
    citations: await cite(ctx, c, value.citations), files,
  });
  await event(ctx, c.run._id, "draft", value.unfilled.length ? `Draft ready: ${value.unfilled.length} field(s) to confirm` : "Draft ready", c.batch._id);
}

/** Sandbox paths a lawyer must never read: out/…, input.json, /workspace/…, /tmp/…, <batch_dir>. */
const WORKING_PATH = /(?:^|[\s(`"'])(?:out\/[\w.-]*\w|\/?(?:workspace|tmp)\/[\w./-]*\w|input\.json|<batch_dir>)/;
const PROSE_KEY = /^(?:summary|finding|answer_md|.+_md)$/;

/** Prose fields of a result that name a working file. Each one is a repair request for the agent. */
export function leakedPaths(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leakedPaths(v, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = at ? `${at}.${k}` : k;
    if (typeof v === "string" && PROSE_KEY.test(k)) {
      const m = v.match(WORKING_PATH);
      return m ? [`"${here}" names the working file "${m[0].trim().replace(/^[(`"']/, "")}". A lawyer reads this text: write "the redline", "the draft" or the document's filename instead.`] : [];
    }
    return typeof v === "object" ? leakedPaths(v, here) : [];
  });
}

/**
 * Accept one schema-valid result file (the action ran ajv and stored the files it
 * names). Every citation is checked against Lumen's own paragraphs before a value
 * is written. Returns problems the schema cannot see (a row for a document outside the batch).
 */
export const ingestResult = internalMutation({
  args: { batchId: v.id("runBatches"), path: v.string(), version: v.string(), value: v.any(), files: v.optional(v.array(fileArg)) },
  returns: v.array(v.string()),
  handler: async (ctx, { batchId, path, version, value, files = [] }) => {
    const batch = await ctx.db.get(batchId);
    const run = batch && (await ctx.db.get(batch.runId));
    if (!batch || !run || TERMINAL_BATCH.has(batch.status)) return [];
    const c: Ctx = { run, batch, allowed: new Set<string>(batch.documentIds), unverified: 0 };
    const problems: string[] = [];
    const expected = resultContract(run.kind, batch.phase).schema;
    const got = String(value.schema ?? "").split("/")[0];
    if (got !== expected) return [`${path}: a ${got} result does not belong here; write a ${expected} result`];
    const leaks = leakedPaths(value);
    if (leaks.length) return leaks.map((l) => `${path}: ${l}`);
    if (got === "review-row") await ingestRow(ctx, c, value, problems);
    else if (got === "answer") {
      const citations = await cite(ctx, c, value.citations);
      const old = await ctx.db.query("answers").withIndex("by_run", (q) => q.eq("runId", run._id)).first();
      const row = { runId: run._id, matterId: run.matterId, question: run.question ?? "", addressed: !!value.addressed,
        answerMd: String(value.answer_md).slice(0, 6000), citations };
      if (old) await ctx.db.replace(old._id, row);
      else await ctx.db.insert("answers", row);
      await event(ctx, run._id, "answer", value.addressed ? "Answer ready" : "Answer ready: the documents do not address this", batchId);
    } else if (got === "issues") await ingestIssues(ctx, c, value, files);
    else if (got === "diligence-report") await ingestReport(ctx, c, value, files);
    else if (got === "draft") await ingestDraft(ctx, c, value, files, problems);
    if (problems.length && got === "draft") return problems;
    if (c.unverified) await event(ctx, run._id, "citations", `${c.unverified} citation${c.unverified === 1 ? "" : "s"} not found in the source`, batchId);
    const old = await ctx.db.query("runFiles").withIndex("by_batch_path", (q) => q.eq("batchId", batchId).eq("path", path)).unique();
    const fileRow = { batchId, path, version, status: "accepted" as const, errors: problems.length ? problems : undefined };
    if (old) await ctx.db.patch(old._id, fileRow);
    else await ctx.db.insert("runFiles", fileRow);
    await ctx.db.patch(batchId, { lastProgressAt: Date.now(), waitingSince: undefined });
    return problems;
  },
});

/** A result waits for a file it names (the agent writes it to Drive, which syncs it a few seconds later). */
export const markWaiting = internalMutation({
  args: { batchId: v.id("runBatches"), reset: v.optional(v.boolean()) },
  returns: v.number(),
  handler: async (ctx, { batchId, reset }) => {
    const b = await ctx.db.get(batchId);
    if (!b) return 0;
    if (b.waitingSince && !reset) return b.waitingSince;
    const now = Date.now();
    await ctx.db.patch(batchId, { waitingSince: now });
    return now;
  },
});

/** The validated checklist rows a diligence reduce batch reads: only cells with a verified or relocated citation, or not_found. */
export const reduceRows = internalQuery({
  args: { runId: v.id("runs") },
  returns: v.array(v.object({ docId: v.string(), row: v.any() })),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run?.reviewId) return [];
    const review = await ctx.db.get(run.reviewId);
    const cells = await ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", run.reviewId!)).collect();
    const out = [];
    for (const id of run.documentIds) {
      const doc = await ctx.db.get(id);
      const mine = cells.filter((c) => c.documentId === id && (c.state === "filled" || c.state === "not_found"));
      if (!doc || !mine.length) continue;
      const row: Record<string, unknown> = {};
      for (const c of mine) {
        row[c.columnKey] = {
          label: review?.columns.find((x) => x.key === c.columnKey)?.label, value: c.editedValue ?? c.value ?? null, not_found: c.state === "not_found",
          note: c.note, citations: c.citations.filter((x) => x.status !== "unverified").map((x) => ({ doc_id: id, a: `p${x.page}.${x.para}`, quote: x.quote })),
        };
      }
      out.push({ docId: id, row: { schema: "review-row/1", doc_id: id, filename: doc.filename, cells: row } });
    }
    return out;
  },
});

async function failPendingCells(ctx: MutationCtx, run: Doc<"runs">, documentIds: Id<"documents">[]) {
  if (!run.reviewId) return;
  const ids = new Set<string>(documentIds);
  const keys = run.columnKeys && new Set(run.columnKeys);
  for (const c of await ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", run.reviewId!)).collect()) {
    if (c.state === "pending" && ids.has(c.documentId) && (!keys || keys.has(c.columnKey))) await ctx.db.patch(c._id, { state: "error", note: "This document could not be read in this run." });
  }
}

/**
 * Schedule every run of the firm that has a pending batch. A finished batch frees a
 * firm-wide slot, and the batch waiting for it may belong to another run.
 */
async function wakeFirm(ctx: MutationCtx, firmId: Id<"firms">) {
  const pending = await ctx.db.query("runBatches").withIndex("by_firm_status", (q) => q.eq("firmId", firmId).eq("status", "pending")).take(200);
  for (const runId of new Set(pending.map((b) => b.runId))) await ctx.scheduler.runAfter(0, internal.runs.schedule, { runId });
}

/** Operator: re-run the scheduler for a firm (scripts only). */
export const wake = internalMutation({
  args: { firmId: v.id("firms") },
  returns: v.null(),
  handler: async (ctx, { firmId }) => {
    await wakeFirm(ctx, firmId);
    return null;
  },
});

/** A batch reached succeeded or failed: start the next ones, and finish the run when every batch is terminal. */
export const settleBatch = internalMutation({
  args: { batchId: v.id("runBatches"), status: v.union(v.literal("succeeded"), v.literal("failed")), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { batchId, status, error }) => {
    const b = await ctx.db.get(batchId);
    const run = b && (await ctx.db.get(b.runId));
    if (!b || !run || TERMINAL_BATCH.has(b.status)) return null;
    await ctx.db.patch(batchId, { status, error, finishedAt: Date.now() });
    const name = b.phase === "reduce" ? "Report" : `Batch ${b.index + 1}`;
    await event(ctx, run._id, status === "succeeded" ? "batch_done" : "batch_failed",
      status === "succeeded" ? `${name} done` : `${name} failed: ${error ?? "no reason given"}`, batchId);
    if (status === "failed" && b.phase !== "reduce") await failPendingCells(ctx, run, b.documentIds);
    if (TERMINAL_RUN.has(run.status)) return null;
    const batches = await batchesOf(ctx, run._id);
    if (batches.every((x) => TERMINAL_BATCH.has(x.status))) {
      const ok = batches.filter((x) => x.status === "succeeded").length;
      const final = ok === batches.length ? "succeeded" : ok > 0 ? "partial" : "failed";
      const firm = await ctx.db.get(run.firmId);
      await ctx.db.patch(run._id, { status: final, finishedAt: Date.now(), ...(final === "succeeded" ? {} : { error: `${batches.length - ok} of ${batches.length} batches failed` }) });
      await event(ctx, run._id, final, `${ok} of ${batches.length} batches succeeded`);
      if (firm) await audit(ctx, { firm, actorId: "system", action: "run.finish", matterId: run.matterId, detail: `${run.title}: ${final}` });
    }
    await wakeFirm(ctx, run.firmId);
    return null;
  },
});

/** A run start (prepare) or a batch launch has this long before the watchdog reads it as interrupted. */
export const START_STALL_MS = 10 * 60_000;
/** The watchdog's margin over poll's own limits: poll settles first while its chain is alive. */
const SWEEP_GRACE_MS = 5 * 60_000;
const ACTIVE_RUN = ["queued", "preparing", "running", "finalizing"] as const;

/**
 * The watchdog (convex/crons.ts, every 5 min). An action that a deploy or a
 * backend restart interrupts is not retried, and nothing else re-drives its
 * run. This settles every active run that stopped moving:
 * - queued/preparing with no event for 10 min → failed (Retry runs it again)
 * - a batch stuck in starting for 10 min → failed
 * - a working batch past the 20 min no-progress limit (+5 min) → failed
 * - a running run past 60 min (+5 min) → failed
 * - a running run with pending batches and none running → scheduled again
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({ failedRuns: v.number(), failedBatches: v.number(), rescheduled: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const out = { failedRuns: 0, failedBatches: 0, rescheduled: 0 };
    const lastEventAt = async (runId: Id<"runs">, batchId?: Id<"runBatches">) => {
      const events = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).order("desc").take(200);
      const e = batchId ? events.find((x) => x.batchId === batchId) : events[0];
      return e?.at ?? 0;
    };
    for (const firm of await ctx.db.query("firms").collect()) {
      for (const status of ACTIVE_RUN) {
        const runs = await ctx.db.query("runs").withIndex("by_firm_status", (q) => q.eq("firmId", firm._id).eq("status", status)).take(100);
        for (const run of runs) {
          const since = Math.max(run._creationTime, await lastEventAt(run._id));
          if (status === "queued" || status === "preparing") {
            if (now - since < START_STALL_MS) continue;
            await failRun(ctx, run, "The run stopped while it was starting. Retry it.");
            out.failedRuns++;
            continue;
          }
          if (run.startedAt && now - run.startedAt > RUN_TIMEOUT_MS + SWEEP_GRACE_MS) {
            await failRun(ctx, run, "The run took longer than 60 minutes");
            out.failedRuns++;
            continue;
          }
          const batches = await batchesOf(ctx, run._id);
          let live = 0;
          for (const b of batches) {
            if (b.status === "starting" && now - Math.max(since, await lastEventAt(run._id, b._id)) > START_STALL_MS) {
              await ctx.scheduler.runAfter(0, internal.runs.settleBatch, { batchId: b._id, status: "failed", error: "The workspace could not start" });
              out.failedBatches++;
            } else if ((b.status === "working" || b.status === "validating") && now - (b.lastProgressAt ?? b.startedAt ?? since) > NO_PROGRESS_MS + SWEEP_GRACE_MS) {
              await ctx.scheduler.runAfter(0, internal.runs.settleBatch, { batchId: b._id, status: "failed", error: "No progress for 20 minutes" });
              out.failedBatches++;
            } else if ((RUNNING_BATCH as readonly string[]).includes(b.status)) live++;
          }
          if (!live && batches.some((b) => b.status === "pending") && now - since > START_STALL_MS) {
            await ctx.scheduler.runAfter(0, internal.runs.schedule, { runId: run._id });
            out.rescheduled++;
          }
        }
      }
    }
    if (out.failedRuns || out.failedBatches || out.rescheduled) console.warn(`[lumen] watchdog: ${JSON.stringify(out)}`);
    return out;
  },
});

/** markRun(failed) for the watchdog, with the finish audit row a settled run gets. */
async function failRun(ctx: MutationCtx, run: Doc<"runs">, error: string) {
  const now = Date.now();
  await ctx.db.patch(run._id, { status: "failed", error, finishedAt: now });
  await event(ctx, run._id, "failed", error);
  for (const b of await batchesOf(ctx, run._id)) {
    if (!TERMINAL_BATCH.has(b.status)) await ctx.db.patch(b._id, { status: "failed", error, finishedAt: now });
  }
  await failPendingCells(ctx, run, run.documentIds);
  const firm = await ctx.db.get(run.firmId);
  if (firm) await audit(ctx, { firm, actorId: "system", action: "run.finish", matterId: run.matterId, detail: `${run.title}: failed` });
  await wakeFirm(ctx, run.firmId);
}

/** Operator view of a run (scripts only): status, batches and the event log. */
export const debug = internalQuery({
  args: { runId: v.id("runs") },
  returns: v.any(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    const batches = await batchesOf(ctx, runId);
    const idx = new Map(batches.map((b) => [b._id, b.index]));
    const events = await ctx.db.query("runEvents").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    return {
      status: run.status, error: run.error, kind: run.kind, reviewId: run.reviewId, startedAt: run.startedAt, finishedAt: run.finishedAt,
      batches: batches.map((b) => ({ index: b.index, status: b.status, error: b.error, attempts: b.attempts, session: b.kortixSessionId })),
      events: events.map((e) => ({ at: e.at, type: e.type, detail: e.detail, batchIndex: e.batchId ? idx.get(e.batchId) : undefined })),
    };
  },
});
