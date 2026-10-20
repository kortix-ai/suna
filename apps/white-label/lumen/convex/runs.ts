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
import { COUNSEL_AGENT, EXTRACTOR_AGENT } from "./lumenAgent";
import { batchStatus, cellState, checkedCitation, column, runKind, runStatus } from "./schema";

export const DOCS_PER_BATCH = 4;
export const MAX_RUNNING_PER_RUN = 4;
export const MAX_RUNNING_PER_FIRM = 8;
export const LIMITS = { repair: 2, nudge: 2, relaunch: 1 };
export const NO_PROGRESS_MS = 20 * 60_000;
export const RUN_TIMEOUT_MS = 60 * 60_000;

type Column = Infer<typeof column>;

/** The "Commercial contract basics" preset. Keys are stable: the eval answer key uses them. */
export const PRESET_COLUMNS: Column[] = [
  { key: "parties", label: "Parties", prompt: "Who are the parties to the agreement, and what role does each have?", format: "text" },
  { key: "term", label: "Term", prompt: "How long does the agreement, or its main obligation, last?", format: "text" },
  { key: "auto_renewal", label: "Auto-renewal", prompt: "Does the agreement renew automatically?", format: "yes_no" },
  {
    key: "termination_convenience", label: "Termination for convenience",
    prompt: "Can a party terminate without cause (for convenience, for any reason, or under a break clause)?", format: "yes_no",
  },
  { key: "liability_cap", label: "Liability cap", prompt: "Is liability capped, and at what amount?", format: "text" },
  { key: "governing_law", label: "Governing law", prompt: "Which law governs the agreement?", format: "text" },
  { key: "assignment", label: "Assignment", prompt: "Can a party assign the agreement, and on what condition?", format: "text" },
  {
    key: "change_of_control", label: "Change of control",
    prompt: "Does the agreement contain a change-of-control provision: a consent requirement, condition or termination right triggered by a change of control of a party or of the target?",
    format: "yes_no",
  },
];

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
  if (!ids) return ready;
  const picked = ids.map((id) => ready.find((d) => d._id === id));
  if (picked.some((d) => !d)) throw new Error("400: every document must be ready and in this matter");
  return picked as Doc<"documents">[];
}

async function createRun(
  ctx: MutationCtx,
  a: { matter: Doc<"matters">; firm: Doc<"firms">; userId: string; kind: "review" | "ask"; title: string; docs: Doc<"documents">[];
    reviewId?: Id<"reviews">; question?: string },
) {
  if (a.docs.length === 0) throw new Error("400: add documents to the vault first");
  const runId = await ctx.db.insert("runs", {
    firmId: a.firm._id, matterId: a.matter._id, kind: a.kind, title: a.title, status: "queued", reviewId: a.reviewId,
    question: a.question, documentIds: a.docs.map((d) => d._id), createdBy: a.userId,
  });
  const groups = a.kind === "ask" ? [a.docs] : chunk(a.docs, DOCS_PER_BATCH);
  for (const [index, group] of groups.entries()) {
    await ctx.db.insert("runBatches", {
      runId, firmId: a.firm._id, index, agent: a.kind === "ask" ? COUNSEL_AGENT : EXTRACTOR_AGENT, status: "pending",
      documentIds: group.map((d) => d._id), attempts: { repair: 0, nudge: 0, relaunch: 0 },
    });
  }
  await event(ctx, runId, "queued", `${a.docs.length} documents in ${groups.length} batch${groups.length === 1 ? "" : "es"}`);
  await audit(ctx, { firm: a.firm, actorId: a.userId, action: "run.start", matterId: a.matter._id, detail: `${a.kind}: ${a.title}` });
  await ctx.scheduler.runAfter(0, internal.engine.prepare, { runId });
  return runId;
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

type Actor = { matter: Doc<"matters">; firm: Doc<"firms">; userId: string };
const reviewArgs = {
  matterId: v.id("matters"),
  title: v.optional(v.string()),
  documentIds: v.optional(v.array(v.id("documents"))),
  columns: v.optional(v.array(column)),
};
const askArgs = { matterId: v.id("matters"), question: v.string(), documentIds: v.optional(v.array(v.id("documents"))) };

async function startReviewFor(
  ctx: MutationCtx, { matter, firm, userId }: Actor, a: { title?: string; documentIds?: Id<"documents">[]; columns?: Column[] },
) {
  const docs = await readyDocs(ctx, matter._id, a.documentIds);
  const columns = a.columns ?? PRESET_COLUMNS;
  if (columns.length === 0 || columns.length > 20 || new Set(columns.map((c) => c.key)).size !== columns.length) {
    throw new Error("400: 1-20 columns with distinct keys");
  }
  if (columns.some((c) => !/^[a-z][a-z0-9_]{0,39}$/.test(c.key))) throw new Error("400: column keys are lower_snake_case");
  const title = a.title?.trim().slice(0, 120) || "Commercial contract basics";
  const reviewId = await ctx.db.insert("reviews", {
    firmId: firm._id, matterId: matter._id, title, documentIds: docs.map((d) => d._id), columns, createdBy: userId,
  });
  for (const d of docs) {
    for (const c of columns) {
      await ctx.db.insert("reviewCells", { reviewId, documentId: d._id, columnKey: c.key, state: "pending", citations: [], reviewStatus: "none" });
    }
  }
  const runId = await createRun(ctx, { matter, firm, userId, kind: "review", title, docs, reviewId });
  return { runId, reviewId };
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
async function asOwner(ctx: MutationCtx, matterId: Id<"matters">): Promise<Actor> {
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

async function requireRun(ctx: QueryCtx, runId: Id<"runs">) {
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
  args: { runId: v.id("runs") },
  returns: v.union(
    v.null(),
    v.object({
      run: runRow,
      error: v.optional(v.string()),
      question: v.optional(v.string()),
      batches: v.array(v.object({
        _id: v.id("runBatches"), index: v.number(), status: batchStatus, documentCount: v.number(), error: v.optional(v.string()),
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
    }),
  ),
  handler: async (ctx, { runId }) => {
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
    return {
      run: await rowOf(ctx, run),
      error: run.error,
      question: run.question,
      batches: batches.map((b) => ({
        _id: b._id, index: b.index, status: b.status, documentCount: b.documentIds.length, error: b.error, attempts: b.attempts,
        startedAt: b.startedAt, finishedAt: b.finishedAt,
      })),
      events: events.reverse().map((e) => ({ at: e.at, type: e.type, detail: e.detail, batchIndex: e.batchId ? indexOf.get(e.batchId) : undefined })),
      documents: run.documentIds.map((id) => ({ _id: id, filename: names.get(id) ?? "Document" })),
      columns: review?.columns ?? [],
      cells: await Promise.all(cells.map(async (c) => ({
        documentId: c.documentId, columnKey: c.columnKey, state: c.state, value: c.editedValue ?? c.value, note: c.note,
        confidence: c.confidence, citations: await Promise.all(c.citations.map(paraText)),
      }))),
      answer: answer ? { addressed: answer.addressed, answerMd: answer.answerMd, citations: await Promise.all(answer.citations.map(paraText)) } : null,
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
    return { run, firm, matter, columns: review?.columns ?? null, batches, docs: docs.filter(Boolean) };
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
    for (const b of batches) {
      if (b.status !== "pending") continue;
      if (runRunning >= MAX_RUNNING_PER_RUN || firmRunning >= MAX_RUNNING_PER_FIRM) break;
      await ctx.db.patch(b._id, { status: "starting" });
      await event(ctx, runId, "starting", `Batch ${b.index + 1}: starting a workspace`, b._id);
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

/**
 * Accept one schema-valid result file (the action ran ajv). Returns problems
 * the schema cannot see (a row for a document outside the batch). Verified or
 * edited cells keep their value; the new AI answer goes to aiValue.
 */
export const ingestResult = internalMutation({
  args: { batchId: v.id("runBatches"), path: v.string(), version: v.string(), value: v.any() },
  returns: v.array(v.string()),
  handler: async (ctx, { batchId, path, version, value }) => {
    const b = await ctx.db.get(batchId);
    const run = b && (await ctx.db.get(b.runId));
    if (!b || !run || TERMINAL_BATCH.has(b.status)) return [];
    const allowed = new Set<string>(b.documentIds);
    const problems: string[] = [];
    let unverified = 0;
    if (run.kind === "review" && value.schema === "review-row/1") {
      const review = run.reviewId && (await ctx.db.get(run.reviewId));
      const documentId = ctx.db.normalizeId("documents", value.doc_id);
      if (!review || !documentId || !allowed.has(documentId)) return [`doc_id ${value.doc_id} is not a document of this batch`];
      for (const col of review.columns) {
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
        const { citations, dropped } = await checkCitations(ctx, cell.citations ?? [], allowed);
        unverified += dropped + citations.filter((c) => c.status === "unverified").length;
        const supported = citations.some((c) => c.status !== "unverified");
        const state = cell.not_found ? "not_found" : supported ? "filled" : "needs_review";
        const human = row.reviewStatus === "verified" || row.editedValue !== undefined;
        await ctx.db.patch(row._id, {
          state: human ? row.state : state,
          ...(human ? { aiValue: cell.value } : { value: cell.value, aiValue: undefined }),
          note: cell.note, confidence: cell.confidence, citations, runId: run._id,
        });
      }
      await event(ctx, run._id, "row", `Row ready: ${(await ctx.db.get(documentId))?.filename ?? value.doc_id}`, batchId);
    } else if (run.kind === "ask" && value.schema === "answer/1") {
      const { citations, dropped } = await checkCitations(ctx, value.citations ?? [], allowed);
      unverified += dropped + citations.filter((c) => c.status === "unverified").length;
      const old = await ctx.db.query("answers").withIndex("by_run", (q) => q.eq("runId", run._id)).first();
      const row = { runId: run._id, matterId: run.matterId, question: run.question ?? "", addressed: !!value.addressed,
        answerMd: String(value.answer_md).slice(0, 6000), citations };
      if (old) await ctx.db.replace(old._id, row);
      else await ctx.db.insert("answers", row);
      await event(ctx, run._id, "answer", value.addressed ? "Answer ready" : "Answer ready: the documents do not address this", batchId);
    } else {
      return [`${path}: a ${value.schema} result does not belong to a ${run.kind} run`];
    }
    if (unverified) await event(ctx, run._id, "citations", `${unverified} citation${unverified === 1 ? "" : "s"} not found in the source`, batchId);
    const old = await ctx.db.query("runFiles").withIndex("by_batch_path", (q) => q.eq("batchId", batchId).eq("path", path)).unique();
    const fileRow = { batchId, path, version, status: "accepted" as const, errors: problems.length ? problems : undefined };
    if (old) await ctx.db.patch(old._id, fileRow);
    else await ctx.db.insert("runFiles", fileRow);
    await ctx.db.patch(batchId, { lastProgressAt: Date.now() });
    return problems;
  },
});

async function failPendingCells(ctx: MutationCtx, run: Doc<"runs">, documentIds: Id<"documents">[]) {
  if (!run.reviewId) return;
  const ids = new Set<string>(documentIds);
  for (const c of await ctx.db.query("reviewCells").withIndex("by_review", (q) => q.eq("reviewId", run.reviewId!)).collect()) {
    if (c.state === "pending" && ids.has(c.documentId)) await ctx.db.patch(c._id, { state: "error", note: "This document could not be read in this run." });
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
    await event(ctx, run._id, status === "succeeded" ? "batch_done" : "batch_failed",
      status === "succeeded" ? `Batch ${b.index + 1} done` : `Batch ${b.index + 1} failed: ${error ?? "no reason given"}`, batchId);
    if (status === "failed") await failPendingCells(ctx, run, b.documentIds);
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
