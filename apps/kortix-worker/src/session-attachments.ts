import { createHash } from "node:crypto";
import { sessionAttachmentPath } from '../../../packages/shared/src/session-attachment-path';
import { promptFileReferenceXml } from '../../../packages/shared/src/prompt-attachments';
import { sessionAttachmentReference } from '../../../packages/sdk/src/core/runtime/session-attachment-reference';

const PREFIX = "kortix-attachment:sha256:";
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
export const isNativeImageAttachment = (file: { mime: string }) => IMAGE_TYPES.has(file.mime);

export interface PromptAttachment {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

export class AttachmentInputError extends Error {}

export function attachmentDigest(url: string): string | null {
  return url.startsWith(PREFIX) &&
    /^[a-f0-9]{64}$/.test(url.slice(PREFIX.length))
    ? url.slice(PREFIX.length)
    : null;
}

export function parsePromptAttachment(
  part: Record<string, unknown>,
): PromptAttachment {
  for (const field of Object.keys(part)) {
    if (!["type", "mime", "url", "filename"].includes(field))
      throw new AttachmentInputError(
        `file part field "${field}" is not supported`,
      );
  }
  if (typeof part.mime !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(part.mime))
    throw new AttachmentInputError(
      "invalid attachment MIME type",
    );
  if (typeof part.url !== "string" || !attachmentDigest(part.url))
    throw new AttachmentInputError(
      "Pi attachments require an immutable session attachment reference",
    );
  if (
    part.filename !== undefined &&
    (typeof part.filename !== "string" ||
      part.filename.length > 255 ||
      part.filename.includes("\0"))
  )
    throw new AttachmentInputError("invalid attachment filename");
  return {
    type: "file",
    mime: part.mime,
    url: part.url,
    ...(part.filename === undefined
      ? {}
      : { filename: part.filename as string }),
  };
}

export function attachmentUserContent(text: string, files: unknown) {
  return [
    { type: "text", text },
    ...(Array.isArray(files)
      ? files.map((file) => isNativeImageAttachment(file) ? ({
          type: "image",
          data: "",
          mimeType: file.mime,
          kortixAttachment: file,
        }) : ({
          type: 'text',
          text: promptFileReferenceXml({ path: sessionAttachmentPath({ ...file, sha256: attachmentDigest(file.url)! }), mime: file.mime, filename: file.filename || 'upload' }),
          kortixAttachment: file,
        }))
      : []),
  ];
}

interface StoredImageContent {
  type: "image";
  data: "";
  mimeType: string;
  kortixAttachment: PromptAttachment;
}

export type RegisterAttachmentPart = (
  ref: string,
  file: PromptAttachment,
) => string | void;

export function restoreUserAttachmentParts(
  parts: Array<Record<string, unknown>>,
  content: unknown,
  register?: RegisterAttachmentPart,
) {
  const files = Array.isArray(content)
    ? content.filter(block => (block?.type === 'image' || block?.type === 'text') && block.kortixAttachment).map(block => block.kortixAttachment)
    : [];
  let index = 0;
  return parts.map(part => {
    if (part.type !== 'file') return part;
    const file = files[index++];
    if (!file || typeof part.url !== 'string') return part;
    return { ...part, url: register?.(part.url, parsePromptAttachment(file)) ?? part.url };
  });
}

export function toolImageParts(
  content: unknown,
  identity: { sessionID: string; messageID: string; partID: string },
  register?: RegisterAttachmentPart,
) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => {
    if (block?.type !== "image" || !block.kortixAttachment) return [];
    const file = parsePromptAttachment(block.kortixAttachment);
    const id = `${identity.partID}-image-${index}`;
    const url = `/kortix/part/${identity.sessionID}/${identity.messageID}/${id}`;
    const storedUrl = register?.(url, file);
    return [
      {
        type: "file" as const,
        id,
        sessionID: identity.sessionID,
        messageID: identity.messageID,
        mime: file.mime,
        filename:
          file.filename ??
          `image-${index + 1}.${file.mime === "image/jpeg" ? "jpg" : file.mime.split("/")[1]}`,
        url: storedUrl ?? url,
      },
    ];
  });
}

export class SessionAttachmentStore {
  private readonly cache = new Map<
    string,
    { bytes: Buffer<ArrayBuffer>; contentType: string }
  >();
  private cacheBytes = 0;
  private readonly partReferences = new Map<string, PromptAttachment>();
  readonly registerPart = (ref: string, file: PromptAttachment): string => {
    this.partReferences.set(ref, { ...file });
    const canonical = this.projectId && this.sessionId
      ? sessionAttachmentReference(this.projectId, this.sessionId, attachmentDigest(file.url) ?? '') ?? ref
      : ref;
    this.partReferences.set(canonical, { ...file });
    return canonical;
  };
  referenceForPart(ref: string): PromptAttachment | undefined {
    return this.partReferences.get(ref);
  }
  constructor(
    private readonly baseUrl?: string,
    private readonly sessionId?: string,
    private readonly headers: Record<string, string> = {},
    private readonly projectId?: string,
  ) {}

  async read(file: PromptAttachment, signal?: AbortSignal) {
    const sha256 = attachmentDigest(file.url);
    if (!sha256 || !this.baseUrl || !this.sessionId)
      throw new AttachmentInputError(
        "immutable session attachment storage is unavailable",
      );
    signal?.throwIfAborted();
    const cached = this.cache.get(sha256);
    if (cached) {
      if (cached.contentType !== file.mime)
        throw new AttachmentInputError(
          "attachment MIME type does not match stored bytes",
        );
      this.cache.delete(sha256);
      this.cache.set(sha256, cached);
      return cached.bytes;
    }
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(this.sessionId)}/attachments/${sha256}`,
      {
        headers: this.headers,
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (response.status === 404)
      throw new AttachmentInputError("session attachment not found");
    if (!response.ok)
      throw new Error(`session attachment storage returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType !== file.mime) {
      await response.body?.cancel();
      throw new AttachmentInputError(
        "attachment MIME type does not match stored bytes",
      );
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new AttachmentInputError("attachment exceeds 8 MiB");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AttachmentInputError("attachment is empty");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new AttachmentInputError("attachment exceeds 8 MiB");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    if (!size || createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("session attachment integrity check failed");
    this.remember(sha256, bytes, contentType);
    return bytes;
  }

  private remember(sha256: string, bytes: Buffer<ArrayBuffer>, contentType: string) {
    const previous = this.cache.get(sha256);
    if (previous) {
      this.cacheBytes -= previous.bytes.length;
      this.cache.delete(sha256);
    }
    while (
      this.cacheBytes + bytes.length > MAX_CACHE_BYTES &&
      this.cache.size
    ) {
      const key = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(key)!.bytes.length;
      this.cache.delete(key);
    }
    this.cache.set(sha256, { bytes, contentType });
    this.cacheBytes += bytes.length;
  }

  async persistImages<T>(
    content: readonly T[],
    signal?: AbortSignal,
  ): Promise<Array<T | StoredImageContent>> {
    signal?.throwIfAborted();
    const pending: Array<{
      index: number;
      file: PromptAttachment;
      bytes: Buffer<ArrayBuffer>;
    }> = [];
    let total = 0;
    for (const [index, block] of content.entries()) {
      const image = block as {
        type?: unknown;
        data?: unknown;
        mimeType?: unknown;
        kortixAttachment?: unknown;
      };
      if (image?.type !== "image") continue;
      if (pending.length >= 16)
        throw new AttachmentInputError("tool results allow at most 16 images");
      if (
        typeof image.mimeType !== "string" ||
        !IMAGE_TYPES.has(image.mimeType)
      )
        throw new AttachmentInputError(
          "Pi image attachments require PNG, JPEG, GIF, or WebP",
        );
      let file: PromptAttachment;
      let bytes: Buffer<ArrayBuffer>;
      if (image.kortixAttachment) {
        file = parsePromptAttachment(
          image.kortixAttachment as Record<string, unknown>,
        );
        if (file.mime !== image.mimeType)
          throw new AttachmentInputError(
            "attachment MIME type does not match image",
          );
        bytes = await this.read(file, signal);
      } else {
        if (typeof image.data !== "string" || !image.data.length)
          throw new AttachmentInputError("tool image is empty");
        if (image.data.length > Math.ceil(MAX_BYTES / 3) * 4)
          throw new AttachmentInputError("attachment exceeds 8 MiB");
        if (image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.data))
          throw new AttachmentInputError("tool image has invalid base64");
        bytes = Buffer.from(image.data, "base64");
        if (bytes.toString("base64") !== image.data)
          throw new AttachmentInputError("tool image has invalid base64");
        if (bytes.length > MAX_BYTES)
          throw new AttachmentInputError("attachment exceeds 8 MiB");
        file = {
          type: "file",
          mime: image.mimeType,
          url: PREFIX + createHash("sha256").update(bytes).digest("hex"),
        };
      }
      total += bytes.length;
      if (total > MAX_CACHE_BYTES)
        throw new AttachmentInputError("tool image attachments exceed 16 MiB");
      pending.push({ index, file, bytes });
    }
    const result: Array<T | StoredImageContent> = [...content];
    for (const { index, file, bytes } of pending) {
      signal?.throwIfAborted();
      if (!this.baseUrl || !this.sessionId)
        throw new AttachmentInputError(
          "immutable session attachment storage is unavailable",
        );
      const sha256 = attachmentDigest(file.url)!;
      const cached = this.cache.get(sha256);
      if (cached && cached.contentType !== file.mime)
        throw new AttachmentInputError(
          "attachment MIME type does not match stored bytes",
        );
      if (!cached) {
        const timeout = AbortSignal.timeout(15_000);
        const response = await fetch(
          `${this.baseUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(this.sessionId)}/attachments/${sha256}`,
          {
            method: "PUT",
            headers: { ...this.headers, "content-type": file.mime },
            body: bytes,
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          },
        );
        await response.body?.cancel();
        if (response.status !== 204)
          throw new Error(
            `session attachment storage returned ${response.status}`,
          );
        signal?.throwIfAborted();
        this.remember(sha256, bytes, file.mime);
      }
      result[index] = {
        type: "image",
        mimeType: file.mime,
        data: "",
        kortixAttachment: file,
      };
    }
    return result;
  }

  async validate(files: PromptAttachment[], signal?: AbortSignal) {
    let total = 0;
    for (const file of files) {
      total += (await this.read(file, signal)).length;
      if (total > MAX_CACHE_BYTES)
        throw new AttachmentInputError(
          "prompt attachments exceed 16 MiB",
        );
    }
  }

  async hydrateHookInput(value: any, signal?: AbortSignal): Promise<any> {
    if (Array.isArray(value)) return this.hydrate(value, signal);
    if (!value || typeof value !== "object") return value;
    const result = { ...value };
    if (Array.isArray(value.context?.messages))
      result.context = {
        ...value.context,
        messages: await this.hydrate(value.context.messages, signal),
      };
    for (const key of ["messages", "toolResults"])
      if (Array.isArray(value[key]))
        result[key] = await this.hydrate(value[key], signal);
    for (const key of ["message", "result", "partialResult"])
      if (Array.isArray(value[key]?.content))
        result[key] = (await this.hydrate([value[key]], signal))[0];
    return result;
  }

  async hydrate<T extends object>(
    messages: T[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    signal?.throwIfAborted();
    const jobs = new Map<string, {
      file: PromptAttachment;
      destinations: Array<{ content: any[]; index: number }>;
    }>();
    const result = messages.map(message => {
      const source = message as { content?: unknown };
      if (!Array.isArray(source.content)) return message;
      const content = [...source.content];
      for (const [index, block] of content.entries()) {
        if (block?.type === 'text' && block.kortixAttachment) content[index] = { type: 'text', text: block.text };
        if (block?.type === "image" && block.kortixAttachment) {
          const file = parsePromptAttachment(block.kortixAttachment);
          const key = JSON.stringify([file.url, file.mime]);
          let job = jobs.get(key);
          if (!job) {
            job = { file, destinations: [] };
            jobs.set(key, job);
          }
          job.destinations.push({ content, index });
        }
      }
      return { ...message, content };
    });
    const pending = [...jobs.values()];
    const controller = new AbortController();
    const readSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let next = 0;
    const readers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (next < pending.length) {
        readSignal.throwIfAborted();
        const { file, destinations } = pending[next++]!;
        const bytes = await this.read(file, readSignal);
        readSignal.throwIfAborted();
        const data = bytes.toString("base64");
        for (const { content, index } of destinations) {
          content[index] = { type: "image", mimeType: file.mime, data };
        }
      }
    });
    try {
      await Promise.all(readers);
    } catch (error) {
      controller.abort(error);
      await Promise.allSettled(readers);
      throw error;
    }
    return result;
  }
}
