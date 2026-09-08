import type { FilePartInput } from '../../runtime/client';
import { authenticatedFetch } from "../../http/auth";
import { platformConfig } from "../../http/config";

export interface KortixSessionAttachment {
  sha256: string;
  contentType: string;
  size: number;
}

const MAX_BYTES = 8 * 1024 * 1024;
const path = (projectId: string, sessionId: string, sha256: string) => {
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("sha256 must be 64 lowercase hexadecimal characters");
  return `${platformConfig().backendUrl || ""}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments/${sha256}`;
};

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function assertSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
  } | null;
  throw new Error(
    typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : `attachment request failed (${response.status})`,
  );
}

export async function putSessionAttachment(
  projectId: string,
  sessionId: string,
  content: Uint8Array,
  options?: { contentType?: string; signal?: AbortSignal },
): Promise<KortixSessionAttachment> {
  if (content.byteLength === 0) throw new Error("attachment is empty");
  if (content.byteLength > MAX_BYTES)
    throw new Error("attachment exceeds 8 MiB");
  const contentType = (
    options?.contentType ?? "application/octet-stream"
  ).toLowerCase();
  const bytes = new Uint8Array(content);
  const sha256 = await digest(bytes);
  const response = await authenticatedFetch(
    path(projectId, sessionId, sha256),
    {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes,
      signal: options?.signal,
    },
  );
  await assertSuccess(response);
  return { sha256, contentType, size: bytes.byteLength };
}

export async function getSessionAttachment(
  projectId: string,
  sessionId: string,
  sha256: string,
  options?: { signal?: AbortSignal },
): Promise<KortixSessionAttachment & { bytes: Uint8Array }> {
  const response = await authenticatedFetch(
    path(projectId, sessionId, sha256),
    { signal: options?.signal },
  );
  await assertSuccess(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await digest(bytes)) !== sha256)
    throw new Error("attachment digest does not match the requested sha256");
  return {
    sha256,
    bytes,
    size: bytes.byteLength,
    contentType:
      response.headers.get("content-type") || "application/octet-stream",
  };
}


export async function putSessionImage(
  projectId: string,
  sessionId: string,
  content: Uint8Array,
  options: { contentType: string; filename?: string; signal?: AbortSignal },
): Promise<FilePartInput> {
  const mime = options.contentType.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
    throw new Error('Pi image attachments require PNG, JPEG, GIF, or WebP');
  if (options.filename !== undefined && (options.filename.length > 255 || options.filename.includes('\0')))
    throw new Error('invalid attachment filename');
  const stored = await putSessionAttachment(projectId, sessionId, content, { contentType: mime, signal: options.signal });
  return { type: 'file', mime: stored.contentType, url: `kortix-attachment:sha256:${stored.sha256}`,
    ...(options.filename === undefined ? {} : { filename: options.filename }) };
}
