import { ApiError, backendApi } from "../../http/api-client";
import { authenticatedFetch } from "../../http/auth";
import { platformConfig } from "../../http/config";
import { unwrap } from "./shared";

const MAX_SESSION_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = new RegExp(
  `^kortix-attachment://(${UUID})/(${UUID})/(${UUID})$`,
);

function parseSessionAttachmentRef(value: unknown) {
  if (typeof value !== "string") return null;
  const match = REFERENCE.exec(value);
  return match
    ? { projectId: match[1]!, sessionId: match[2]!, attachmentId: match[3]! }
    : null;
}

export interface SessionAttachment {
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}

export function isSessionAttachmentRef(value: unknown): boolean {
  return parseSessionAttachmentRef(value) !== null;
}

const uploads = new WeakMap<
  File,
  Map<string, { id: string; promise?: Promise<SessionAttachment> }>
>();

/** Save attachment bytes before a session runtime exists. The reference is private and stable. */
export async function uploadSessionAttachment(
  projectId: string,
  sessionId: string,
  file: File,
  options: { attachmentId?: string; signal?: AbortSignal } = {},
): Promise<SessionAttachment> {
  if (file.size > MAX_SESSION_ATTACHMENT_BYTES)
    throw new Error("Attachments must be 50 MiB or smaller.");
  const key = `${projectId}/${sessionId}`;
  const cached = options.attachmentId ? undefined : uploads.get(file)?.get(key);
  if (cached?.promise) return cached.promise;
  const entry = cached ?? {
    id: options.attachmentId ?? crypto.randomUUID(),
    promise: undefined as Promise<SessionAttachment> | undefined,
  };
  if (!options.attachmentId) {
    const scopes = uploads.get(file) ?? new Map();
    scopes.set(key, entry);
    uploads.set(file, scopes);
  }
  const form = new FormData();
  form.append("attachment_id", entry.id);
  form.append("file", file, file.name);
  entry.promise = backendApi
    .upload<SessionAttachment>(
      `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
      form,
      { signal: options.signal, timeout: 120_000, showErrors: false },
    )
    .then(unwrap)
    .catch((error) => {
      entry.promise = undefined;
      throw error;
    });
  return entry.promise;
}

/** Fetch private bytes through the platform API, independent of sandbox readiness. */
export async function fetchSessionAttachment(
  ref: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const scope = parseSessionAttachmentRef(ref);
  if (!scope) throw new Error("Invalid attachment reference");
  const base = platformConfig().backendUrl.replace(/\/$/, "");
  const response = await authenticatedFetch(
    `${base}/projects/${scope.projectId}/sessions/${scope.sessionId}/attachments/${scope.attachmentId}`,
    { signal },
  );
  if (!response.ok)
    throw new ApiError("Could not load attachment", {
      status: response.status,
    });
  return response.blob();
}
