import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Better Auth ids (user, organization) are strings: they live in the betterAuth component.

export const plan = v.union(v.literal("trial"), v.literal("solo"), v.literal("team"), v.literal("firm"));
export const billingStatus = v.union(v.literal("none"), v.literal("active"), v.literal("past_due"), v.literal("canceled"));
export const firmStatus = v.union(v.literal("provisioning"), v.literal("ready"), v.literal("failed"));
export const sizeBand = v.union(v.literal("1"), v.literal("2-10"), v.literal("11-50"), v.literal("51+"));
export const matterStatus = v.union(v.literal("open"), v.literal("on_hold"), v.literal("closed"));
export const visibility = v.union(v.literal("firm"), v.literal("restricted"));
export const partyRole = v.union(
  v.literal("client"), v.literal("counterparty"), v.literal("target"), v.literal("landlord"),
  v.literal("tenant"), v.literal("employee"), v.literal("other"),
);
export const party = v.object({ name: v.string(), role: partyRole });

export const auditAction = v.union(
  v.literal("firm.create"), v.literal("firm.ready"), v.literal("firm.failed"), v.literal("firm.update"),
  v.literal("member.invite"), v.literal("member.join"), v.literal("member.role"), v.literal("member.remove"),
  v.literal("member.invite_cancel"),
  v.literal("matter.create"), v.literal("matter.update"), v.literal("matter.close"),
  v.literal("thread.create"), v.literal("thread.delete"),
  v.literal("token.mint"),
  v.literal("billing.plan"), v.literal("billing.checkout"),
  v.literal("export.csv"),
  v.literal("document.upload"), v.literal("document.delete"),
  v.literal("run.start"), v.literal("run.finish"), v.literal("run.cancel"),
  v.literal("kit.install"),
  v.literal("cell.verify"), v.literal("cell.flag"), v.literal("cell.edit"),
  v.literal("issue.accept"), v.literal("issue.dismiss"),
  v.literal("library.create"), v.literal("library.update"),
  v.literal("export.docx"),
);

export const documentStatus = v.union(v.literal("uploading"), v.literal("extracting"), v.literal("ready"), v.literal("failed"));
export const runKind = v.union(
  v.literal("review"), v.literal("column"), v.literal("ask"), v.literal("contract_review"), v.literal("diligence"), v.literal("draft"),
);
export const severity = v.union(v.literal("high"), v.literal("medium"), v.literal("low"));
export const libraryKind = v.union(v.literal("playbook"), v.literal("template"));
export const runStatus = v.union(
  v.literal("queued"), v.literal("preparing"), v.literal("running"), v.literal("finalizing"),
  v.literal("succeeded"), v.literal("partial"), v.literal("failed"), v.literal("canceled"),
);
export const batchStatus = v.union(
  v.literal("pending"), v.literal("starting"), v.literal("working"), v.literal("validating"),
  v.literal("succeeded"), v.literal("failed"), v.literal("canceled"),
);
export const columnFormat = v.union(
  v.literal("text"), v.literal("yes_no"), v.literal("date"), v.literal("money"), v.literal("tag"), v.literal("verbatim"),
);
export const column = v.object({
  key: v.string(), label: v.string(), prompt: v.string(), format: columnFormat, options: v.optional(v.array(v.string())),
});
export const citationStatus = v.union(v.literal("verified"), v.literal("relocated"), v.literal("unverified"));
/** A citation after Lumen checked it against the source: documentId + anchor + quote + outcome. */
export const checkedCitation = v.object({
  documentId: v.id("documents"), page: v.number(), para: v.number(), quote: v.string(), status: citationStatus,
});
export const cellState = v.union(
  v.literal("pending"), v.literal("filled"), v.literal("not_found"), v.literal("needs_review"), v.literal("error"),
);

export default defineSchema({
  // One Better Auth organization = one firm = one Kortix project.
  firms: defineTable({
    orgId: v.string(),
    name: v.string(),
    practiceTags: v.array(v.string()),
    sizeBand,
    jurisdiction: v.optional(v.string()),
    logoId: v.optional(v.id("_storage")),
    model: v.optional(v.string()),
    kortixProjectId: v.optional(v.string()),
    kortixDriveId: v.optional(v.string()),
    kitVersion: v.optional(v.string()),
    kitHash: v.optional(v.string()),
    status: firmStatus,
    error: v.optional(v.string()),
    plan,
    seats: v.number(),
    billingStatus,
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    trialEndsAt: v.optional(v.number()),
    createdBy: v.string(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_kortixProjectId", ["kortixProjectId"])
    .index("by_stripeCustomerId", ["stripeCustomerId"]),

  matters: defineTable({
    firmId: v.id("firms"),
    name: v.string(),
    number: v.optional(v.string()),
    client: v.string(),
    parties: v.array(party),
    practiceArea: v.optional(v.string()),
    status: matterStatus,
    visibility,
    // Drive path under the firm's project Drive, written by provisioning (stage 2 uses it).
    driveFolder: v.string(),
    /** index.json writes are serialized: concurrent Drive writes to one path become conflict copies. */
    indexWrite: v.optional(v.object({ scheduled: v.boolean(), wantedAt: v.number() })),
    createdBy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_firm_updatedAt", ["firmId", "updatedAt"]),

  matterMembers: defineTable({ matterId: v.id("matters"), userId: v.string() })
    .index("by_matter", ["matterId"])
    .index("by_matter_user", ["matterId", "userId"]),

  threads: defineTable({
    firmId: v.id("firms"),
    matterId: v.id("matters"),
    kortixSessionId: v.string(),
    title: v.string(),
    createdBy: v.string(),
    lastMessageAt: v.number(),
  })
    .index("by_matter", ["matterId"])
    .index("by_firm", ["firmId"])
    .index("by_kortixSessionId", ["kortixSessionId"]),

  // Short-lived project-scoped Kortix PATs, one per (firm, member). Never returned by a public query.
  memberTokens: defineTable({
    firmId: v.id("firms"),
    userId: v.string(),
    tokenId: v.string(),
    secret: v.string(),
    expiresAt: v.number(),
  }).index("by_firm_user", ["firmId", "userId"]),

  // Immutable: no delete mutation exists.
  auditEvents: defineTable({
    firmId: v.optional(v.id("firms")),
    orgId: v.string(),
    actorId: v.string(),
    action: auditAction,
    matterId: v.optional(v.id("matters")),
    detail: v.optional(v.string()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_action", ["orgId", "action"]),

  stripeEvents: defineTable({ eventId: v.string() }).index("by_eventId", ["eventId"]),

  // ── Vault ──
  documents: defineTable({
    firmId: v.id("firms"),
    matterId: v.id("matters"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mime: v.string(),
    bytes: v.number(),
    sha256: v.optional(v.string()),
    pages: v.optional(v.number()),
    paras: v.optional(v.number()),
    status: documentStatus,
    error: v.optional(v.string()),
    /** Drive paths, relative to the firm Drive: the original and the anchored text. */
    driveFile: v.optional(v.string()),
    textFile: v.optional(v.string()),
    uploadedBy: v.string(),
  })
    .index("by_matter", ["matterId"])
    .index("by_matter_sha", ["matterId", "sha256"]),

  documentPages: defineTable({ documentId: v.id("documents"), matterId: v.id("matters"), page: v.number(), text: v.string() })
    .index("by_doc", ["documentId", "page"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["matterId"] }),

  documentParas: defineTable({
    documentId: v.id("documents"), matterId: v.id("matters"), page: v.number(), para: v.number(), text: v.string(),
    heading: v.optional(v.string()),
  }).index("by_doc_para", ["documentId", "para"]),

  // ── Agent kit and orchestration ──
  kitInstalls: defineTable({
    firmId: v.id("firms"),
    version: v.string(),
    hash: v.string(),
    status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_firm", ["firmId"]),

  /** A tabular review: rows = documents, columns = questions. Cells live in reviewCells. */
  reviews: defineTable({
    firmId: v.id("firms"),
    matterId: v.id("matters"),
    title: v.string(),
    documentIds: v.array(v.id("documents")),
    columns: v.array(column),
    createdBy: v.string(),
  }).index("by_matter", ["matterId"]),

  reviewCells: defineTable({
    reviewId: v.id("reviews"),
    documentId: v.id("documents"),
    columnKey: v.string(),
    state: cellState,
    value: v.optional(v.any()),
    note: v.optional(v.string()),
    confidence: v.optional(v.union(v.literal("high"), v.literal("medium"), v.literal("low"))),
    citations: v.array(checkedCitation),
    reviewStatus: v.union(v.literal("none"), v.literal("verified"), v.literal("flagged")),
    editedValue: v.optional(v.any()),
    editedBy: v.optional(v.string()),
    /** The newest AI answer when a verified or edited cell keeps its value. */
    aiValue: v.optional(v.any()),
    runId: v.optional(v.id("runs")),
  })
    .index("by_review", ["reviewId"])
    .index("by_review_doc_col", ["reviewId", "documentId", "columnKey"]),

  /** One question answered from the vault (run kind `ask`). */
  answers: defineTable({
    runId: v.id("runs"),
    matterId: v.id("matters"),
    question: v.string(),
    addressed: v.boolean(),
    answerMd: v.string(),
    citations: v.array(checkedCitation),
  }).index("by_run", ["runId"]),

  /** One user-visible job. It runs as 1..N batches: one Kortix session each. */
  runs: defineTable({
    firmId: v.id("firms"),
    matterId: v.id("matters"),
    kind: runKind,
    title: v.string(),
    status: runStatus,
    reviewId: v.optional(v.id("reviews")),
    question: v.optional(v.string()),
    /** A `column` run fills only these columns of the review. */
    columnKeys: v.optional(v.array(v.string())),
    /** Contract review: the playbook; draft: the template. The body is copied into the run's Drive folder at start. */
    libraryItemId: v.optional(v.id("libraryItems")),
    perspective: v.optional(v.string()),
    fields: v.optional(v.record(v.string(), v.string())),
    documentIds: v.array(v.id("documents")),
    kitVersion: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdBy: v.string(),
  })
    .index("by_matter", ["matterId"])
    .index("by_firm_status", ["firmId", "status"]),

  runBatches: defineTable({
    runId: v.id("runs"),
    firmId: v.id("firms"),
    index: v.number(),
    agent: v.string(),
    /** Diligence: map batches extract the checklist; the reduce batch writes the report once every map batch is done. */
    phase: v.optional(v.union(v.literal("map"), v.literal("reduce"))),
    status: batchStatus,
    documentIds: v.array(v.id("documents")),
    kortixSessionId: v.optional(v.string()),
    attempts: v.object({ repair: v.number(), nudge: v.number(), relaunch: v.number() }),
    startedAt: v.optional(v.number()),
    lastProgressAt: v.optional(v.number()),
    /** When Lumen last sent the session a prompt (launch, repair, nudge): idle checks wait for its turn. */
    lastPromptAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    /** Since when an accepted-schema result waits for a file it names (redline.docx) to reach Drive. */
    waitingSince: v.optional(v.number()),
  })
    .index("by_run", ["runId", "index"])
    .index("by_firm_status", ["firmId", "status"]),

  /** Each result file is ingested once per version (size + mtime). */
  runFiles: defineTable({
    batchId: v.id("runBatches"),
    path: v.string(),
    version: v.string(),
    status: v.union(v.literal("accepted"), v.literal("rejected")),
    errors: v.optional(v.array(v.string())),
  }).index("by_batch_path", ["batchId", "path"]),

  /** Playbooks and templates: firm data, not kit. Each run copies the body it uses into its Drive folder. */
  libraryItems: defineTable({
    firmId: v.id("firms"),
    kind: libraryKind,
    name: v.string(),
    description: v.optional(v.string()),
    body: v.string(),
    updatedBy: v.string(),
    updatedAt: v.number(),
  }).index("by_firm_kind", ["firmId", "kind"]),

  /** Contract review findings: one per playbook rule, plus clauses no rule covers (ruleId "unmatched"). */
  issues: defineTable({
    runId: v.id("runs"),
    matterId: v.id("matters"),
    documentId: v.id("documents"),
    ruleId: v.string(),
    title: v.string(),
    assessment: v.union(v.literal("aligned"), v.literal("deviates"), v.literal("missing"), v.literal("unmatched")),
    severity,
    finding: v.string(),
    redline: v.optional(v.object({ a: v.string(), from: v.string(), to: v.string(), comment: v.string() })),
    citations: v.array(checkedCitation),
    decision: v.union(v.literal("open"), v.literal("accepted"), v.literal("dismissed")),
    order: v.number(),
  }).index("by_run", ["runId", "order"]),

  /** The document-shaped result of a workflow run: a review summary, a diligence report or a draft, and its files. */
  runResults: defineTable({
    runId: v.id("runs"),
    matterId: v.id("matters"),
    kind: v.union(v.literal("issues"), v.literal("report"), v.literal("draft")),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    markdown: v.optional(v.string()),
    unfilled: v.optional(v.array(v.string())),
    sections: v.optional(v.array(v.object({ heading: v.string(), bodyMd: v.string(), citations: v.array(checkedCitation) }))),
    redFlags: v.optional(v.array(v.object({
      title: v.string(), severity, documentId: v.optional(v.id("documents")), citations: v.array(checkedCitation),
    }))),
    citations: v.optional(v.array(checkedCitation)),
    files: v.array(v.object({ name: v.string(), storageId: v.id("_storage"), bytes: v.number() })),
  }).index("by_run", ["runId"]),

  /** The progress stream: the run screen subscribes to it. */
  runEvents: defineTable({
    runId: v.id("runs"),
    batchId: v.optional(v.id("runBatches")),
    at: v.number(),
    type: v.string(),
    detail: v.optional(v.string()),
  }).index("by_run", ["runId", "at"]),
});
