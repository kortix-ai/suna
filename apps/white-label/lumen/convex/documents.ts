// The Vault: a matter's documents. Browser → Convex storage → `ingest`
// (convex/ingest.ts) → pages, anchored paragraphs and the Drive copies the
// agents read. Members never reach Drive directly.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireMatterAccess } from "./access";
import { audit } from "./audit";
import { driveIdOf } from "./deployment";
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
  family: v.id("documents"),
  version: v.number(),
  superseded: v.boolean(),
});

/** The id of a document's first version: its family. */
export const familyOf = (d: Doc<"documents">) => d.family ?? d._id;

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
      status: d.status, error: d.error, uploadedBy: d.uploadedBy, family: familyOf(d), version: d.version ?? 1, superseded: d.superseded ?? false,
    }));
  },
});

/** Convex caps function arguments at 16 MiB, so the browser path takes files up to 15 MiB. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** The Vault's upload: the browser sends the bytes to Lumen's backend, never to Kortix. */
export const upload = action({
  args: { matterId: v.id("matters"), filename: v.string(), bytes: v.bytes(), contentType: v.string(), versionOf: v.optional(v.id("documents")) },
  returns: v.id("documents"),
  handler: async (ctx, { matterId, filename, bytes, contentType, versionOf }): Promise<Id<"documents">> => {
    await ctx.runQuery(internal.documents.checkAccess, { matterId });
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("400: files are limited to 15 MB");
    if (!TYPES[extOf(filename)]) throw new Error("400: PDF, DOCX or TXT only");
    // The same bytes twice in one vault: refused before anything is stored, counted or audited.
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const dup = await ctx.runQuery(internal.documents.sameBytes, { matterId, sha256 });
    if (dup) throw new Error(`409: Already in this vault (${dup})`);
    const storageId = await ctx.storage.store(new Blob([bytes], { type: contentType || TYPES[extOf(filename)] }));
    return await ctx.runMutation(internal.documents.addUploaded, { matterId, storageId, filename, sha256, versionOf });
  },
});

/** A live document of the matter with these bytes (its filename), or null. */
export const sameBytes = internalQuery({
  args: { matterId: v.id("matters"), sha256: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { matterId, sha256 }) => {
    await requireMatterAccess(ctx, matterId);
    const same = await ctx.db.query("documents").withIndex("by_matter_sha", (q) => q.eq("matterId", matterId).eq("sha256", sha256)).collect();
    return same.find((d) => d.status !== "failed")?.filename ?? null;
  },
});

/** The upload action's insert: the caller's identity, and the hash it computed, so a second copy in flight is caught too. */
export const addUploaded = internalMutation({
  args: { matterId: v.id("matters"), storageId: v.id("_storage"), filename: v.string(), sha256: v.string(), versionOf: v.optional(v.id("documents")) },
  returns: v.id("documents"),
  handler: async (ctx, { matterId, storageId, filename, sha256, versionOf }) => {
    const { matter, firm, userId } = await requireMatterAccess(ctx, matterId);
    return await insertDocument(ctx, { firm, matter, userId, storageId, filename, sha256, versionOf });
  },
});

/** Where the Assistant's files for a matter are, for a caller who sees the matter. Null while its folder moves. */
export const outputsTarget = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.union(v.null(), v.object({ driveId: v.string(), driveFolder: v.string() })),
  handler: async (ctx, { matterId }) => {
    const { matter, firm } = await requireMatterAccess(ctx, matterId);
    const driveId = await driveIdOf(ctx);
    if (matter.folderMoving || firm.status !== "ready" || !driveId || !matter.driveFolder) return null;
    return { driveId, driveFolder: matter.driveFolder };
  },
});

/** The current (not superseded) document of the matter with this filename, or null. */
export const currentByName = internalQuery({
  args: { matterId: v.id("matters"), filename: v.string() },
  returns: v.union(v.null(), v.id("documents")),
  handler: async (ctx, { matterId, filename }) => {
    const rows = await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", matterId)).collect();
    return rows.find((d) => d.filename === filename && !d.superseded && d.status !== "failed")?._id ?? null;
  },
});

export const checkAccess = internalQuery({
  args: { matterId: v.id("matters") },
  returns: v.null(),
  handler: async (ctx, { matterId }) => {
    const { matter } = await requireMatterAccess(ctx, matterId);
    // A copy written now would land in the folder being moved away.
    if (matter.folderMoving) throw new Error("409: this matter's documents are being moved. Try again in a minute.");
    return null;
  },
});

/** Validate an uploaded blob and start its ingest. The UI and the seed script both come through here. */
export async function insertDocument(
  ctx: MutationCtx,
  a: {
    firm: Doc<"firms">; matter: Doc<"matters">; userId: string; storageId: Id<"_storage">; filename: string; sha256?: string;
    versionOf?: Id<"documents">;
  },
) {
  const meta = await ctx.db.system.get(a.storageId);
  const name = a.filename.trim().replace(/[/\\]/g, "-").slice(0, 160);
  const mime = TYPES[extOf(name)];
  if (!meta) throw new Error("404: upload not found");
  if (!mime || meta.size > MAX_BYTES) {
    await ctx.storage.delete(a.storageId);
    throw new Error(!mime ? "400: PDF, DOCX or TXT only" : "400: files are limited to 50 MB");
  }
  let versioned: { family: Id<"documents">; version: number } | undefined;
  if (a.versionOf) {
    const parent = await ctx.db.get(a.versionOf);
    if (!parent || parent.matterId !== a.matter._id) {
      await ctx.storage.delete(a.storageId);
      throw new Error("404: the document to version is not in this matter");
    }
    const family = familyOf(parent);
    const siblings = (await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", a.matter._id)).collect())
      .filter((d) => familyOf(d) === family);
    versioned = { family, version: Math.max(...siblings.map((d) => d.version ?? 1)) + 1 };
  }
  const documentId = await ctx.db.insert("documents", {
    firmId: a.firm._id, matterId: a.matter._id, storageId: a.storageId, filename: name, mime, bytes: meta.size, status: "extracting",
    uploadedBy: a.userId, ...(a.sha256 ? { sha256: a.sha256 } : {}), ...versioned,
  });
  await ctx.db.patch(a.matter._id, { updatedAt: Date.now() });
  await audit(ctx, {
    firm: a.firm, actorId: a.userId, action: versioned ? "document.version" : "document.upload", matterId: a.matter._id,
    detail: versioned ? `${name} (V${versioned.version})` : name,
  });
  await ctx.scheduler.runAfter(0, internal.ingest.ingest, { documentId });
  return documentId;
}

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
    return { storageId: d.storageId, filename: d.filename, matterId: d.matterId, driveFolder: m.driveFolder, kortixDriveId: f.status === "ready" ? ((await driveIdOf(ctx)) ?? undefined) : undefined };
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
    // Only an earlier copy counts: two copies in flight do not refuse each other.
    return same.find((o) => o._id !== documentId && o.status !== "failed" && o._creationTime < d._creationTime)?.filename ?? null;
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

/** A copy that ingest found to be a duplicate (an upload that raced another, or the seed path): it leaves no row behind. */
export const discardDuplicate = internalMutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, { documentId }) => {
    const d = await ctx.db.get(documentId);
    if (!d) return null;
    for (const p of await ctx.db.query("documentPages").withIndex("by_doc", (q) => q.eq("documentId", documentId)).collect()) await ctx.db.delete(p._id);
    for (const p of await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId)).collect()) await ctx.db.delete(p._id);
    await ctx.storage.delete(d.storageId).catch(() => undefined);
    await ctx.db.delete(documentId);
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
    // A ready new version supersedes every earlier version of the same document.
    const d = await ctx.db.get(documentId);
    if (!error && d?.family) {
      for (const o of await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", d.matterId)).collect()) {
        if (o._id !== d._id && familyOf(o) === d.family && (o.version ?? 1) < (d.version ?? 1) && !o.superseded) {
          await ctx.db.patch(o._id, { superseded: true });
        }
      }
    }
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
    const driveId = f?.status === "ready" ? await driveIdOf(ctx) : null;
    return m && driveId ? { driveId, driveFolder: m.driveFolder } : null;
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
      .filter((d) => d.status === "ready" && d.textFile && d.driveFile && !d.superseded)
      .map((d) => ({
        doc_id: d._id, filename: d.filename, pages: d.pages ?? 0, paras: d.paras ?? 0,
        text_path: `Text/${d._id}.md`, original_path: `Docs/${d.driveFile!.split("/").pop()}`, sha256: d.sha256 ?? "",
      }));
  },
});

// ── Vault reads: search, preview, delete ──

/** `text` around the first hit of any query term, ≤ ~200 chars. */
export function snippetOf(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ");
  const lower = flat.toLowerCase();
  const at = Math.min(...q.toLowerCase().split(/\s+/).filter(Boolean).map((t) => {
    const i = lower.indexOf(t);
    return i < 0 ? Infinity : i;
  }));
  if (!Number.isFinite(at)) return flat.slice(0, 200);
  const from = Math.max(0, at - 80);
  return `${from > 0 ? "…" : ""}${flat.slice(from, at + 120)}${at + 120 < flat.length ? "…" : ""}`;
}

/** Full-text search over the matter's pages (Convex search index). Null when the caller may not see the matter. */
export const search = query({
  args: { matterId: v.id("matters"), q: v.string() },
  returns: v.union(v.null(), v.array(v.object({
    documentId: v.id("documents"), filename: v.string(), page: v.number(), snippet: v.string(),
  }))),
  handler: async (ctx, { matterId, q }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return null;
    }
    const term = q.trim().slice(0, 200);
    if (!term) return [];
    const pages = await ctx.db
      .query("documentPages")
      .withSearchIndex("search_text", (s) => s.search("text", term).eq("matterId", matterId))
      .take(40);
    // Only current versions: an earlier version's page would show old text under the current name.
    const names = new Map<Id<"documents">, string | null>();
    const out = [];
    for (const p of pages) {
      if (!names.has(p.documentId)) {
        const d = await ctx.db.get(p.documentId);
        names.set(p.documentId, d && !d.superseded ? d.filename : null);
      }
      const filename = names.get(p.documentId);
      if (filename) out.push({ documentId: p.documentId, filename, page: p.page, snippet: snippetOf(p.text, term) });
      if (out.length === 20) break;
    }
    return out;
  },
});

/** One document for the preview panel: its metadata and anchored paragraphs. */
export const detail = query({
  args: { documentId: v.string() },
  returns: v.union(v.null(), v.object({
    _id: v.id("documents"), matterId: v.id("matters"), filename: v.string(), mime: v.string(), pages: v.optional(v.number()),
    paras: v.array(v.object({ page: v.number(), para: v.number(), text: v.string(), heading: v.optional(v.string()) })),
  })),
  handler: async (ctx, { documentId }) => {
    const id = ctx.db.normalizeId("documents", documentId);
    const d = id ? await ctx.db.get(id) : null;
    if (!d) return null;
    try {
      await requireMatterAccess(ctx, d.matterId);
    } catch {
      return null;
    }
    const paras = await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", d._id)).collect();
    return {
      _id: d._id, matterId: d.matterId, filename: d.filename, mime: d.mime, pages: d.pages,       paras: paras.map((p) => ({ page: p.page, para: p.para, text: p.text, heading: p.heading })),
    };
  },
});

/** Delete a document: its rows and blob now, its Drive copies and the matter index right after. */
export const remove = mutation({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, { documentId }) => {
    const d = await ctx.db.get(documentId);
    if (!d) return null;
    const { firm, userId } = await requireMatterAccess(ctx, d.matterId);
    for (const r of await ctx.db.query("documentPages").withIndex("by_doc", (q) => q.eq("documentId", documentId)).collect()) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", documentId)).collect()) await ctx.db.delete(r._id);
    await ctx.db.delete(documentId);
    await ctx.storage.delete(d.storageId);
    await audit(ctx, { firm, actorId: userId, action: "document.delete", matterId: d.matterId, detail: d.filename });
    // Deleting the latest version makes the newest remaining ready version current again.
    if (!d.superseded) {
      const rest = (await ctx.db.query("documents").withIndex("by_matter", (q) => q.eq("matterId", d.matterId)).collect())
        .filter((o) => familyOf(o) === familyOf(d) && o.status === "ready")
        .sort((x, y) => (y.version ?? 1) - (x.version ?? 1));
      if (rest[0]?.superseded) await ctx.db.patch(rest[0]._id, { superseded: false });
    }
    const driveId = await driveIdOf(ctx);
    if (driveId) {
      const paths = [d.driveFile, d.textFile].filter((p): p is string => !!p);
      await ctx.scheduler.runAfter(0, internal.ingest.removeFromDrive, { matterId: d.matterId, driveId, paths });
    }
    return null;
  },
});

/** The original's bytes for the preview, through Lumen's backend (≤ 15 MiB, the browser upload cap). */
export const bytes = action({
  args: { documentId: v.id("documents") },
  returns: v.bytes(),
  handler: async (ctx, { documentId }): Promise<ArrayBuffer> => {
    const storageId = await ctx.runQuery(internal.documents.storageFor, { documentId });
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("404: file not found");
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error("413: too large to preview; download it instead");
    return await blob.arrayBuffer();
  },
});

export const storageFor = internalQuery({
  args: { documentId: v.id("documents") },
  returns: v.id("_storage"),
  handler: async (ctx, { documentId }) => {
    const d = await ctx.db.get(documentId);
    if (!d) throw new Error("404: document not found");
    await requireMatterAccess(ctx, d.matterId);
    return d.storageId;
  },
});
