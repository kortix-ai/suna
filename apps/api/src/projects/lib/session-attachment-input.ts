import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export const MAX_SESSION_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const SESSION_ATTACHMENT_SHA256 = /^[a-f0-9]{64}$/;
const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

export async function readSessionAttachment(request: Request): Promise<Buffer> {
  const tooLarge = () =>
    new HTTPException(413, { message: "attachment exceeds 8 MiB" });
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_SESSION_ATTACHMENT_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "attachment is empty" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SESSION_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0)
    throw new HTTPException(400, { message: "attachment is empty" });
  return Buffer.concat(chunks, size);
}

export function validateAttachmentIdentity(
  sha256: string,
  contentType: string,
  bytes: Buffer,
) {
  if (!SESSION_ATTACHMENT_SHA256.test(sha256)) {
    throw new HTTPException(400, {
      message: "sha256 must be 64 lowercase hexadecimal characters",
    });
  }
  if (!CONTENT_TYPE.test(contentType)) {
    throw new HTTPException(400, {
      message: "content-type must be a MIME type without parameters",
    });
  }
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new HTTPException(400, {
      message: "attachment does not match sha256",
    });
  }
  return { sha256, contentType: contentType.toLowerCase() };
}
