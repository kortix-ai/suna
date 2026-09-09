import { createHash } from "node:crypto";
import { MAX_SESSION_ATTACHMENT_BYTES } from "../lib/session-attachment-input";
import { parseStagedPromptDataUrl } from "./prompt-attachment-materializer";
import type { PromptPartWire } from "./store";

export interface StagedSessionAttachment {
  sha256: string;
  contentType: string;
  content: Buffer;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const REFERENCE = /^kortix-attachment:sha256:[a-f0-9]{64}$/;

export function preparePiPromptAttachments(
  parts: PromptPartWire[],
  options: { allowReferences?: boolean } = {},
): { parts: PromptPartWire[]; attachments: StagedSessionAttachment[] } {
  const attachments = new Map<string, StagedSessionAttachment>();
  let count = 0;
  let size = 0;
  const prepared = parts.map((part): PromptPartWire => {
    if (part.type === "text") return part;
    if (part.type !== "file" || !IMAGE_TYPES.has(part.mime ?? "")) {
      throw new Error(
        "Pi prompts accept text and PNG, JPEG, GIF, or WebP images",
      );
    }
    if (++count > 16) throw new Error("Pi prompts accept up to 16 images");
    if (
      part.source !== undefined ||
      part.filename?.includes("\0") ||
      (part.filename?.length ?? 0) > 255
    ) {
      throw new Error("invalid Pi image attachment metadata");
    }
    if (REFERENCE.test(part.url ?? "")) {
      if (!options.allowReferences)
        throw new Error("upload image bytes when creating a new session");
      return part;
    }
    if (!part.url?.toLowerCase().startsWith("data:")) {
      throw new Error("upload local image bytes before sending a Pi prompt");
    }
    const { bytes } = parseStagedPromptDataUrl(part);
    if (bytes.byteLength === 0) throw new Error("image attachment is empty");
    if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES)
      throw new Error("image attachment exceeds 8 MiB");
    size += bytes.byteLength;
    if (size > 16 * 1024 * 1024)
      throw new Error("Pi image attachments exceed 16 MiB");
    const content = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const existing = attachments.get(sha256);
    if (existing && existing.contentType !== part.mime)
      throw new Error("attachment bytes and MIME type are immutable");
    attachments.set(sha256, { sha256, contentType: part.mime!, content });
    return {
      type: "file",
      mime: part.mime,
      url: `kortix-attachment:sha256:${sha256}`,
      ...(part.filename === undefined ? {} : { filename: part.filename }),
    };
  });
  return { parts: prepared, attachments: [...attachments.values()] };
}
