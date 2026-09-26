import { normalizeActivityToolName } from "../../turns/segments/session-activity-groups";
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

/**
 * One stored file a transcript references: something a user attached, or a
 * file an agent showed. The bytes live in the session's private store, so they
 * can be fetched while the sandbox is stopped — pass `url` to
 * {@link fetchSessionAttachment}, or `attachment_id` to
 * `kortix.session(projectId, sessionId).attachments.read()`.
 */
export interface SessionAttachmentReference {
  /** The `kortix-attachment://` reference. */
  url: string;
  attachment_id: string;
  /** As the transcript names it, or null when it names none. */
  filename: string | null;
  /** As the transcript declares it, or null. A file an agent showed carries
   *  no declared type here; the store answers it with the bytes. */
  mime: string | null;
  /** The message that references it. */
  message_id: string;
  /** Who put it in the conversation: `user` for an upload, `assistant` for a
   *  file it showed. */
  role: string;
}

/** Tools whose card an agent uses to hand the user a result. */
const SHOWN_TOOLS = new Set(["show", "show_user"]);
/**
 * The attribute text of every `<file …>…</file>` block — a prompt's inline file
 * reference, as the runtime writes it into user text.
 *
 * NOT A REGEX. `/<file\s+([^>]*?)>[\s\S]*?<\/file>/g` is quadratic: `\s+` and
 * `[^>]*?` both match whitespace, so `<file` followed by N spaces and no `>` is
 * re-split N ways (CodeQL js/polynomial-redos; ~10 s at 200k characters). This
 * reads user text, so each search starts past the previous one and the scan
 * stops as soon as a delimiter it needs is absent from the rest — if no `>` or
 * `</file>` follows one opener, none follows any later opener either.
 *
 * Same blocks the regex matched: whitespace required after `file`, attributes
 * up to the first `>`, the body skipped up to the first `</file>`. The platform
 * uses an identical scanner (`@kortix/shared`'s `fileTagBlocks`); this package
 * carries its own copy because it is published without that dependency.
 */
function fileTagAttributes(text: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf("<file", from);
    if (index === -1) return found;
    const after = index + "<file".length;
    if (after >= text.length || !/\s/.test(text[after]!)) {
      from = after;
      continue;
    }
    const gt = text.indexOf(">", after);
    if (gt === -1) return found;
    const close = text.indexOf("</file>", gt + 1);
    if (close === -1) return found;
    found.push(text.slice(after, gt).trimStart());
    from = close + "</file>".length;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const basename = (value: unknown): string | null =>
  typeof value === "string" ? stringOrNull(value.split("/").pop()) : null;

function tagAttribute(attrs: string, key: string): string | null {
  const value = attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
  if (value === undefined) return null;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** `items` arrives as an array or as the JSON string a model often sends. */
function showItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Every stored file a transcript references, in the order it appears, each
 * listed once.
 *
 * Reads a live runtime transcript and a saved one alike — the references are
 * the same `kortix-attachment://` values in both. Pure and defensive: a
 * malformed transcript yields what could be read, never a throw.
 *
 * Three places carry a reference: a `file` part's `url`, an `attachment` on a
 * `<file>` tag in user text, and an `attachment` on a `show` card (or one of its
 * carousel items) recorded by saved history. Anything that is not a stored
 * reference — inline bytes, a sandbox path, a look-alike — is not listed,
 * because a download of it would fail or fetch something else.
 */
export function findSessionAttachments(messages: readonly unknown[]): SessionAttachmentReference[] {
  if (!Array.isArray(messages)) return [];
  const found: SessionAttachmentReference[] = [];
  const seen = new Set<string>();
  const add = (
    url: unknown,
    filename: string | null,
    mime: string | null,
    messageId: string,
    role: string,
  ) => {
    const scope = parseSessionAttachmentRef(url);
    if (!scope || seen.has(url as string)) return;
    seen.add(url as string);
    found.push({
      url: url as string,
      attachment_id: scope.attachmentId,
      filename,
      mime,
      message_id: messageId,
      role,
    });
  };
  for (const message of messages) {
    if (!isObject(message) || !isObject(message.info) || !Array.isArray(message.parts)) continue;
    const messageId = stringOrNull(message.info.id);
    if (!messageId) continue;
    const role = stringOrNull(message.info.role) ?? "unknown";
    for (const part of message.parts) {
      if (!isObject(part)) continue;
      if (part.type === "file") {
        add(part.url, stringOrNull(part.filename), stringOrNull(part.mime), messageId, role);
      } else if (part.type === "text" && typeof part.text === "string") {
        for (const attrs of fileTagAttributes(part.text)) {
          add(
            tagAttribute(attrs, "attachment"),
            tagAttribute(attrs, "filename") ?? basename(tagAttribute(attrs, "path")),
            tagAttribute(attrs, "mime"),
            messageId,
            role,
          );
        }
      } else if (
        part.type === "tool" &&
        typeof part.tool === "string" &&
        SHOWN_TOOLS.has(normalizeActivityToolName(part.tool)) &&
        isObject(part.state) &&
        isObject(part.state.input)
      ) {
        const input = part.state.input;
        for (const card of [input, ...showItems(input.items)]) {
          if (isObject(card)) add(card.attachment, basename(card.path), null, messageId, role);
        }
      }
    }
  }
  return found;
}
