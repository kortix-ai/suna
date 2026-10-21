"use node";

// Ingest one uploaded document: hash, extract text, segment into anchored
// paragraphs (convex/lib/segment.ts, the only segmenter), store them, and put
// the original + Text/<docId>.md + the matter's index.json in the firm's Drive.

import { createHash } from "node:crypto";
import { deleteDriveFile, uploadDriveFile } from "@kortix/sdk";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { extOf } from "./documents";
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

export const ingest = internalAction({
  args: { documentId: v.id("documents") },
  returns: v.null(),
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.runQuery(internal.documents.forIngest, { documentId });
    if (!doc) return null;
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
