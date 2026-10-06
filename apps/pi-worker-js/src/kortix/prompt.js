// What a prompt is, on both of the routes that deliver one: OpenCode's
// `prompt_async` body and the Kortix runtime verb's. kortixd's
// harness/pi/runtime.ts `parsePromptBody`, for the cell.
//
// Kept out of worker.js on purpose: celld loads EVERY named export of the
// entry module as a handler, and refuses one that is not a class or an
// ExportedHandler ("Incorrect type for map entry").
import { MESSAGE_ID } from "./ids.js";

export const CELL_VERSION = "pi-cell/2 (pi 1.0.3, pi-durable)";

/** OpenCode's `prompt_async` body or the Kortix runtime verb's, as one admission. */
export function parsePromptBody(raw, { verb = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("prompt body must be an object");
  const messageId = verb ? raw.message_id : raw.messageID;
  if (messageId !== undefined && (typeof messageId !== "string" || !MESSAGE_ID.test(messageId))) {
    throw new Error("message id must be a Kortix message id (msg_ + 12 hex clock + 14 base62)");
  }
  let model;
  if (typeof raw.model === "string" && raw.model.trim()) model = raw.model.trim();
  else if (raw.model && typeof raw.model === "object") {
    if (typeof raw.model.providerID !== "string" || typeof raw.model.modelID !== "string") throw new Error("model must contain providerID and modelID strings");
    model = `${raw.model.providerID}/${raw.model.modelID}`;
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) throw new Error("parts must be a non-empty array");
  const text = [];
  const files = [];
  for (const part of raw.parts) {
    if (!part || typeof part !== "object") throw new Error("prompt parts must be objects");
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new Error("text parts require a string text field");
      text.push(part.text);
    } else if (part.type === "file") {
      if (typeof part.url !== "string" || !part.url) throw new Error("file parts require a url");
      files.push({ mime: typeof part.mime === "string" && part.mime ? part.mime : "application/octet-stream", url: part.url, ...(typeof part.filename === "string" ? { filename: part.filename } : {}) });
      if (files.length > 16) throw new Error("at most 16 attachments are supported per prompt");
    } else {
      throw new Error(`prompt part type "${typeof part.type === "string" ? part.type : "unknown"}" is not supported`);
    }
  }
  if (text.join("").trim().length === 0 && files.length === 0) throw new Error("prompt has no content");
  const noReply = verb ? raw.no_reply === true : raw.noReply === true;
  return {
    ...(messageId ? { messageId } : {}),
    text: text.join(""),
    files,
    ...(typeof raw.agent === "string" && raw.agent ? { agent: raw.agent } : {}),
    ...(model ? { model } : {}),
    ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}),
    ...(noReply ? { noReply: true } : {}),
  };
}

