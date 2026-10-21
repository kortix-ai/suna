"use node";

// Ingest one uploaded document: hash, extract text, segment into anchored
// paragraphs (convex/lib/segment.ts, the only segmenter), store them, and put
// the original + Text/<docId>.md + the matter's index.json in the firm's Drive.

import { createHash } from "node:crypto";
import { deleteDriveFile, listDriveFolder, readDriveFile, uploadDriveFile } from "@kortix/sdk";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction } from "./_generated/server";
import { MAX_UPLOAD_BYTES, extOf } from "./documents";
import { requireProxy } from "./access";
import { renderText, sectionsFromText, segment } from "./lib/segment";
import { asOperator, errorText, withRetry, ensureFolder } from "./operator";

/** Raw text per page. DOCX and TXT have no pages, so a page is a ~3,000-character section. */
async function pagesOf(filename: string, bytes: Uint8Array): Promise<string[]> {
  const ext = extOf(filename);
  if (ext === "pdf") {
    // pdf.js takes ownership of (detaches) the buffer it gets: give it a copy, the bytes still go to Drive.
    const { text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: false });
    return text as string[];
  }
  if (ext === "docx") return sectionsFromText((await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value);
  return sectionsFromText(new TextDecoder("utf-8").decode(bytes));
}

const slug = (filename: string) =>
  filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";

/** Rewrite index.json from Convex (the only writer; documents.requestIndex serializes it). */
export const writeIndex = internalAction({
  args: { matterId: v.id("matters") },
  returns: v.null(),
  handler: async (ctx, { matterId }) => {
    const startedAt = Date.now();
    try {
      const target = await ctx.runQuery(internal.documents.indexTarget, { matterId });
      if (target) {
        const index = await ctx.runQuery(internal.documents.matterIndex, { matterId });
        const body = new TextEncoder().encode(JSON.stringify(index, null, 1));
        await asOperator(() => withRetry(() => uploadDriveFile(target.driveId, `${target.driveFolder}/index.json`, body)));
      }
    } catch (err) {
      console.error(`[lumen] index ${matterId}: ${errorText(err)}`);
    }
    await ctx.runMutation(internal.documents.indexWritten, { matterId, startedAt });
    return null;
  },
});

const DRIVE_WAIT_MS = 10_000;
const DRIVE_WAIT_ATTEMPTS = 30; // 5 min, past the slowest measured provisioning

export const ingest = internalAction({
  args: { documentId: v.id("documents"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { documentId, attempt = 0 }) => {
    const doc = await ctx.runQuery(internal.documents.forIngest, { documentId });
    if (!doc) return null;
    // An upload during onboarding can land before provisioning has created the firm's Drive
    // (about a minute). Wait for it instead of failing the document.
    if (!doc.kortixDriveId && attempt < DRIVE_WAIT_ATTEMPTS) {
      await ctx.scheduler.runAfter(DRIVE_WAIT_MS, internal.ingest.ingest, { documentId, attempt: attempt + 1 });
      return null;
    }
    try {
      const blob = await ctx.storage.get(doc.storageId);
      if (!blob) throw new Error("the upload is gone");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const dup = await ctx.runQuery(internal.documents.duplicateOf, { documentId, sha256 });
      if (dup) {
        console.warn(`[lumen] ingest ${documentId}: duplicate of ${dup}, discarded`);
        await ctx.runMutation(internal.documents.discardDuplicate, { documentId });
        return null;
      }
      let pages: string[];
      try {
        pages = await pagesOf(doc.filename, bytes);
      } catch (err) {
        console.error(`[lumen] extract ${documentId}: ${errorText(err)}`);
        await ctx.runMutation(internal.documents.settle, { documentId, error: "Could not read this file. Is it a valid PDF, DOCX or TXT?" });
        return null;
      }
      const paras = segment(pages);
      await ctx.runMutation(internal.documents.savePages, { documentId, sha256, pages, paras });
      if (!doc.kortixDriveId) throw new Error("the firm has no Drive yet");
      const driveId = doc.kortixDriveId;
      const driveFile = `${doc.driveFolder}/Docs/${documentId}-${slug(doc.filename)}.${extOf(doc.filename)}`;
      const textFile = `${doc.driveFolder}/Text/${documentId}.md`;
      await asOperator(async () => {
        for (const p of [doc.driveFolder, `${doc.driveFolder}/Docs`, `${doc.driveFolder}/Text`]) await ensureFolder(driveId, p);
        await withRetry(() => uploadDriveFile(driveId, driveFile, bytes));
        await withRetry(() => uploadDriveFile(driveId, textFile, new TextEncoder().encode(renderText(documentId, doc.filename, pages.length, paras))));
      });
      await ctx.runMutation(internal.documents.settle, { documentId, driveFile, textFile });
      await ctx.runMutation(internal.documents.requestIndex, { matterId: doc.matterId });
    } catch (err) {
      await ctx.runMutation(internal.documents.settle, { documentId, error: errorText(err) });
    }
    return null;
  },
});

/** Drop a deleted document's Drive copies, then rewrite the matter's index.json. */
export const removeFromDrive = internalAction({
  args: { matterId: v.id("matters"), driveId: v.string(), paths: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { matterId, driveId, paths }) => {
    for (const p of paths) {
      try {
        await asOperator(() => withRetry(() => deleteDriveFile(driveId, p)));
      } catch (err) {
        console.error(`[lumen] drive delete ${p}: ${errorText(err)}`);
      }
    }
    await ctx.runMutation(internal.documents.requestIndex, { matterId });
    return null;
  },
});

/**
 * Files the Assistant wrote for the lawyer (`<matter folder>/Outputs/`, kit rule in
 * agent-kit/agents/lumen-counsel.md) become matter documents: read, anchored, citable,
 * in the vault. A file with the name of a current document becomes its next version;
 * bytes the vault already holds are skipped. The thread calls this when a turn ends,
 * the vault when it opens. Returns the filenames added.
 */
export const importOutputs = action({
  args: { matterId: v.id("matters") },
  returns: v.array(v.string()),
  handler: async (ctx, { matterId }): Promise<string[]> => {
    const t = await ctx.runQuery(internal.documents.outputsTarget, { matterId });
    if (!t) return [];
    const listed = await asOperator(() => listDriveFolder(t.driveId, `${t.driveFolder}/Outputs`)).catch(() => null);
    const added: string[] = [];
    for (const e of listed?.entries ?? []) {
      if (e.type !== "file" || !["pdf", "docx", "txt"].includes(extOf(e.name)) || e.size === 0 || e.size > MAX_UPLOAD_BYTES) continue;
      const { blob } = await asOperator(() => withRetry(() => readDriveFile(t.driveId, e.path)));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (await ctx.runQuery(internal.documents.sameBytes, { matterId, sha256 })) continue;
      const versionOf: Id<"documents"> | null = await ctx.runQuery(internal.documents.currentByName, { matterId, filename: e.name });
      const storageId = await ctx.storage.store(new Blob([bytes], { type: blob.type || "application/octet-stream" }));
      await ctx.runMutation(internal.documents.addUploaded, { matterId, storageId, filename: e.name, sha256, ...(versionOf ? { versionOf } : {}) });
      added.push(e.name);
    }
    return added;
  },
});

const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/**
 * A file inside the matter's folder, by the path its sessions see
 * (`/drives/...`): the bytes behind an Assistant output card's preview and
 * download. The sandbox's own file route serves only its workspace, so Lumen
 * reads the matter's Drive folder instead. The proxy only (LUMEN_PROXY_SECRET),
 * for a caller who sees the matter; nothing outside the matter folder.
 */
export const matterFile = action({
  args: { matterId: v.id("matters"), path: v.string(), proxySecret: v.string() },
  returns: v.object({ bytes: v.bytes(), mime: v.string(), name: v.string() }),
  handler: async (ctx, { matterId, path, proxySecret }): Promise<{ bytes: ArrayBuffer; mime: string; name: string }> => {
    requireProxy(proxySecret);
    const t = await ctx.runQuery(internal.documents.outputsTarget, { matterId });
    if (!t) throw new Error("409: this matter's files are being moved");
    const dir = t.matterDir;
    const abs = path.startsWith("/") ? path : `/${path}`;
    if (!abs.startsWith(`${dir}/`) || abs.split("/").includes("..")) throw new Error("403: only this matter's files");
    const { blob } = await asOperator(() => withRetry(() => readDriveFile(t.driveId, `${t.driveFolder}${abs.slice(dir.length)}`)));
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error("413: too large to open here");
    const name = abs.split("/").pop() ?? "file";
    return { bytes: await blob.arrayBuffer(), mime: FILE_TYPES[extOf(name)] ?? "application/octet-stream", name };
  },
});
