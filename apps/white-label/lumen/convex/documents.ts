// The Vault: a matter's documents. Browser → Convex storage → `ingest`
// (convex/ingest.ts) → pages, anchored paragraphs and the Drive copies the
// agents read. Members never reach Drive directly.

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireMatterAccess } from "./access";
import { audit } from "./audit";
import { documentStatus } from "./schema";

export const MAX_BYTES = 50 * 1024 * 1024;
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};
export const extOf = (filename: string) => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

const documentView = v.object({
  _id: v.id("documents"),
  _creationTime: v.number(),
  filename: v.string(),
  bytes: v.number(),
  pages: v.optional(v.number()),
  paras: v.optional(v.number()),
  status: documentStatus,
  error: v.optional(v.string()),
  uploadedBy: v.string(),
});

/** The matter's documents, newest first. Null when the caller may not see the matter. */
export const list = query({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.array(documentView)),
  handler: async (ctx, { matterId }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return null;
    }
    const rows = await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", matterId)).order("desc").take(500);
    return rows.map((d) => ({
      _id: d._id, _creationTime: d._creationTime, filename: d.filename, bytes: d.bytes, pages: d.pages, paras: d.paras,
      status: d.status, error: d.error, uploadedBy: d.uploadedBy,
    }));
  },
});

/** Convex caps function arguments at 16 MiB, so the browser path takes files up to 15 MiB. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** The Vault's upload: the browser sends the bytes to Lumen's backend, never to Kortix. */
export const upload = action({
  args: { matterId: v.id("matters"), filename: v.string(), bytes: v.bytes(), contentType: v.string() },
  returns: v.id("documents"),
  handler: async (ctx, { matterId, filename, bytes, contentType }): Promise<Id<"documents">> => {
    await ctx.runQuery(internal.documents.checkAccess, { matterId });
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("400: files are limited to 15 MB");
    if (!TYPES[extOf(filename)]) throw new Error("400: PDF, DOCX or TXT only");
    const storageId = await ctx.storage.store(new Blob([bytes], { type: contentType || TYPES[extOf(filename)] }));
    return await ctx.runMutation(api.documents.add, { matterId, storageId, filename });
  },
});

export const checkAccess = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.null(),
  handler: async (ctx, { matterId }) => {
    await requireMatterAccess(ctx, matterId);
    return null;
  },
});

/** Validate an uploaded blob and start its ingest. The UI and the seed script both come through here. */
export async function insertDocument(
  ctx: MutationCtx,
  a: { firm: Doc<"firms">; matter: Doc<"matters">; userId: string; storageId: Id<"_storage">; filename: string },
) {
  const meta = await ctx.db.system.get(a.storageId);
  const name = a.filename.trim().replace(/[/\\]/g, "-").slice(0, 160);
  const mime = TYPES[extOf(name)];
  if (!meta) throw new Error("404: upload not found");
  if (!mime || meta.size > MAX_BYTES) {
    await ctx.storage.delete(a.storageId);
    throw new Error(!mime ? "400: PDF, DOCX or TXT only" : "400: files are limited to 50 MB");
  }
  const documentId = await ctx.db.insert("documents", {
    firmId: a.firm._id, matterId: a.matter._id, storageId: a.storageId, filename: name, mime, bytes: meta.size, status: "extracting",
    uploadedBy: a.userId,
  });
  await ctx.db.patch(a.matter._id, { updatedAt: Date.now() });
  await audit(ctx, { firm: a.firm, actorId: a.userId, action: "document.upload", matterId: a.matter._id, detail: name });
  await ctx.scheduler.runAfter(0, internal.ingest.ingest, { documentId });
  return documentId;
}

/** Record an uploaded file and start its ingest. PDF, DOCX or TXT, at most 50 MiB. */
export const add = mutation({
  args: { matterId: v.id("matters"), storageId: v.id("_storage"), filename: v.string() },
  returns: v.id("documents"),
  handler: async (ctx, { matterId, storageId, filename }) => {
    const { matter, firm, userId } = await requireMatterAccess(ctx, matterId);
    return await insertDocument(ctx, { firm, matter, userId, storageId, filename });
  },
});

// ── internal: the ingest action and the run engine ──

export const forIngest = internalQuery({
  args: { documentId: v.id("documents") },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.id("_storage"), filename: v.string(), matterId: v.id("matters"), driveFolder: v.string(),
      kortixDriveId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { documentId }) => {
    const d = await ctx.db.get(documentId);
    const m = d && (await ctx.db.get(d.matterId));
    const f = d && (await ctx.db.get(d.firmId));
    if (!d || !m || !f) return null;
    return { storageId: d.storageId, filename: d.filename, matterId: d.matterId, driveFolder: m.driveFolder, kortixDriveId: f.kortixDriveId };
  },
});

/** Another ready document in the matter with these bytes, or null. */
export const duplicateOf = internalQuery({
  args: { documentId: v.id("documents"), sha256: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { documentId, sha256 }) => {
    const d = await ctx.db.get(documentId);
    if (!d) return null;
    const same = await ctx.db.query("documents").withIndex("by_matter_sha", (q) => q.eq("matterId", d.matterId).eq("sha256", sha256)).collect();
    return same.find((o) => o._id !== documentId && o.status !== "failed")?.filename ?? null;
  },
});

const segment = v.object({ page: v.number(), para: v.number(), text: v.string(), heading: v.optional(v.string()) });

/** Pages and paragraphs, replaced as a whole (a re-ingest is idempotent). */
export const savePages = internalMutation({
  args: { documentId: v.id("documents"), sha256: v.string(), pages: v.array(v.string()), paras: v.array(segment) },
  returns: v.null(),
  handler: async (ctx, { documentId, sha256, pages, paras }) => {
    const d = await ctx.db.get(documentId);
    if (!d) return null;
    for (const old of await ctx.db.query("documentPages").withIndex("by_doc", (q) => q.eq("documentId", documentId)).collect()) {
      await ctx.db.delete(old._id);
    }
    for (const old of await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId)).collect()) {
      await ctx.db.delete(old._id);
    }
    for (const [i, text] of pages.entries()) await ctx.db.insert("documentPages", { documentId, matterId: d.matterId, page: i + 1, text });
    for (const p of paras) await ctx.db.insert("documentParas", { documentId, matterId: d.matterId, ...p });
    await ctx.db.patch(documentId, { sha256, pages: pages.length, paras: paras.length });
    return null;
  },
});

export const settle = internalMutation({
  args: {
    documentId: v.id("documents"),
    driveFile: v.optional(v.string()),
    textFile: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { documentId, driveFile, textFile, error }) => {
    if (error) console.error(`[lumen] ingest ${documentId}: ${error}`);
    // A member reads a generic reason; the raw cause stays in the log.
    const shown = error?.startsWith("Already in this vault") || error?.startsWith("Could not read") ? error : "Processing failed. Upload it again.";
    await ctx.db.patch(documentId, error ? { status: "failed", error: shown } : { status: "ready", driveFile, textFile, error: undefined });
    return null;
  },
});

/** Ask for the matter's index.json to be rewritten. At most one write is scheduled or running per matter. */
export const requestIndex = internalMutation({
  args: { matterId: v.id("matters") },
  returns: v.null(),
  handler: async (ctx, { matterId }) => {
    const m = await ctx.db.get(matterId);
    if (!m) return null;
    const scheduled = m.indexWrite?.scheduled ?? false;
    await ctx.db.patch(matterId, { indexWrite: { scheduled: true, wantedAt: Date.now() } });
    if (!scheduled) await ctx.scheduler.runAfter(1500, internal.ingest.writeIndex, { matterId });
    return null;
  },
});

export const indexTarget = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.object({ driveId: v.string(), driveFolder: v.string() })),
  handler: async (ctx, { matterId }) => {
    const m = await ctx.db.get(matterId);
    const f = m && (await ctx.db.get(m.firmId));
    return m && f?.kortixDriveId ? { driveId: f.kortixDriveId, driveFolder: m.driveFolder } : null;
  },
});

/** A write finished: run once more if someone asked after it started, else release the slot. */
export const indexWritten = internalMutation({
  args: { matterId: v.id("matters"), startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { matterId, startedAt }) => {
    const m = await ctx.db.get(matterId);
    if (!m?.indexWrite) return null;
    if (m.indexWrite.wantedAt > startedAt) await ctx.scheduler.runAfter(500, internal.ingest.writeIndex, { matterId });
    else await ctx.db.patch(matterId, { indexWrite: { ...m.indexWrite, scheduled: false } });
    return null;
  },
});

/** index.json for a matter: every ready document (the agents' document list). */
export const matterIndex = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.array(v.object({
    doc_id: v.string(), filename: v.string(), pages: v.number(), paras: v.number(), text_path: v.string(), original_path: v.string(), sha256: v.string(),
  })),
  handler: async (ctx, { matterId }) => {
    const rows = await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", matterId)).collect();
    return rows
      .filter((d) => d.status === "ready" && d.textFile && d.driveFile)
      .map((d) => ({
        doc_id: d._id, filename: d.filename, pages: d.pages ?? 0, paras: d.paras ?? 0,
        text_path: `Text/${d._id}.md`, original_path: `Docs/${d.driveFile!.split("/").pop()}`, sha256: d.sha256 ?? "",
      }));
  },
});

/** Every paragraph of these documents, for citation checks. */
export const parasOf = internalQuery({
  args: { documentIds: v.array(v.id("documents")) },
  returns: v.array(v.object({ documentId: v.id("documents"), page: v.number(), para: v.number(), text: v.string() })),
  handler: async (ctx, { documentIds }) => {
    const out = [];
    for (const documentId of documentIds) {
      for (const p of await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId)).collect()) {
        out.push({ documentId, page: p.page, para: p.para, text: p.text });
      }
    }
    return out;
  },
});

