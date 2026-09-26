import path from 'node:path';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  fileTagBlocks,
  parseSessionAttachmentRef,
  sessionAttachmentRef,
  type SessionAttachmentScope,
} from '@kortix/shared';
import { parseStagedPromptDataUrl } from '../session-lifecycle/prompt-attachment-materializer';
import { stableSessionAttachmentId } from './session-attachment-identity';

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
type SavedFile = SessionAttachmentScope & {
  filename: string;
  mime: string;
  bytes: Uint8Array;
};
const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const attribute = (attrs: string, key: string) => {
  const value = attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : unescape(value);
};
function workspacePath(value: string): string | null {
  let input = value;
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value);
      if (url.hostname) return null;
      input = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(input) || input.includes('\0')) return null;
  const normalized = path.posix.resolve('/workspace', input);
  return normalized.startsWith('/workspace/') ? normalized : null;
}

export async function readTranscriptAttachmentBytes(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Attachment read failed (${response.status})`);
  if (Number(response.headers.get('content-length')) > MAX_SESSION_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw new Error('Attachment exceeds 50 MiB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Attachment read returned no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SESSION_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new Error('Attachment exceeds 50 MiB');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface RecoverInput {
  messages: unknown[];
  previous: Map<string, Part[]>;
  projectId: string;
  sessionId: string;
  recover: boolean;
  readFile: (path: string) => Promise<Uint8Array | null>;
  saveFile: (file: SavedFile) => Promise<{ url: string }>;
  onFailure: (filename: string, error: unknown) => void;
  signal?: AbortSignal;
}

/**
 * Copy one original into the private store and answer its reference, or null.
 *
 * The attachment id is derived from EXACTLY this key. Changing its shape would
 * stop every stored reference from matching `previousUrl`, and the next
 * capture would re-read and re-upload every file the session ever held.
 */
async function saveRecovered(
  input: RecoverInput,
  identity: string,
  source: string,
  filename: string,
  mime: string,
  suffix: string,
  previousUrl?: unknown,
): Promise<string | null> {
  const scope = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    attachmentId: stableSessionAttachmentId(
      `${input.sessionId}:${identity}:${suffix}:${filename}:${mime}:${source}`,
    ),
  };
  const url = sessionAttachmentRef(scope);
  if (previousUrl === url) return url;
  if (!input.recover || input.signal?.aborted) return null;
  try {
    let bytes: Uint8Array | null;
    if (source.startsWith('data:')) {
      if (source.length > (MAX_SESSION_ATTACHMENT_BYTES * 4) / 3 + 1024)
        throw new Error('Attachment exceeds 50 MiB');
      bytes = parseStagedPromptDataUrl({
        url: source,
        mime,
        filename,
      }).bytes;
    } else {
      const filePath = workspacePath(source);
      if (!filePath) return null;
      bytes = await input.readFile(filePath);
    }
    if (!bytes) throw new Error('Original attachment is unavailable');
    if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES)
      throw new Error('Attachment exceeds 50 MiB');
    return (await input.saveFile({ ...scope, filename, mime, bytes })).url;
  } catch (error) {
    input.onFailure(filename, error);
    return null;
  }
}

// ── Artifacts an agent SHOWED ──────────────────────────────────────────────
//
// `show` is how an agent hands the user a result, and a file-backed one points
// at a path inside the sandbox. Saved history keeps the card (see the mirror's
// INPUT_RENDERED_TOOLS) but not the bytes, so while the sandbox is off the card
// had nothing to load. Capture runs while the box is definitionally up, so it
// copies the file into the same private store user attachments use and records
// the reference on the card as `attachment`.
//
// Only the mirror copy carries it: the live runtime's part never changes, so a
// running session renders from the sandbox exactly as before.

/** Same spellings the SDK's `normalizeActivityToolName` treats as `show`. */
const SHOWN_TOOLS = new Set(['show', 'show_user']);
const normalizeToolName = (name: unknown) =>
  (typeof name === 'string' ? name : '').replace(/^oc-/, '').replace(/-/g, '_');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Stored with the bytes, so a download names itself correctly. */
const SHOW_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/** The show `type` when the extension says nothing. `image`/`video`/`audio`
 *  name a family, not a format, so they fall through to octet-stream. */
const SHOW_MIME_BY_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  markdown: 'text/markdown',
  html: 'text/html',
  code: 'text/plain',
  text: 'text/plain',
  xlsx: SHOW_MIME_BY_EXTENSION.xlsx!,
  docx: SHOW_MIME_BY_EXTENSION.docx!,
  pptx: SHOW_MIME_BY_EXTENSION.pptx!,
};

function showArtifactMime(filePath: string, type: unknown): string {
  const ext = path.posix.extname(filePath).slice(1).toLowerCase();
  return (
    SHOW_MIME_BY_EXTENSION[ext] ??
    (typeof type === 'string' ? SHOW_MIME_BY_TYPE[type] : undefined) ??
    'application/octet-stream'
  );
}

/** `items` arrives as an array or as the JSON string the model often sends. */
function showItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One show payload (the card, or one carousel item), with every file it points
 * at copied and referenced. Answers the SAME object when nothing changed, so a
 * caller can tell a no-op without comparing.
 */
async function recoverShowPayload(
  payload: Record<string, unknown>,
  prior: Record<string, unknown> | undefined,
  identity: string,
  suffix: string,
  input: RecoverInput,
): Promise<Record<string, unknown>> {
  let next = payload;
  const source = typeof payload.path === 'string' ? payload.path : null;
  // `url` is left alone: an external page is not the session's to copy, and a
  // preview URL dies with the box it points into. `content` is already inline.
  const filePath = source ? workspacePath(source) : null;
  if (source && filePath && !parseSessionAttachmentRef(payload.attachment)) {
    const url = await saveRecovered(
      input,
      identity,
      source,
      path.posix.basename(filePath),
      showArtifactMime(filePath, payload.type),
      suffix,
      prior?.attachment,
    );
    if (url) next = { ...next, attachment: url };
  }
  const items = showItems(payload.items);
  if (items) {
    const priorItems = showItems(prior?.items) ?? [];
    let changed = false;
    const recovered: unknown[] = [];
    for (const [index, item] of items.entries()) {
      if (!isRecord(item)) {
        recovered.push(item);
        continue;
      }
      const priorItem = priorItems[index];
      const result = await recoverShowPayload(
        item,
        isRecord(priorItem) ? priorItem : undefined,
        identity,
        `${suffix}:${index}`,
        input,
      );
      if (result !== item) changed = true;
      recovered.push(result);
    }
    if (changed) next = { ...next, items: recovered };
  }
  return next;
}

async function recoverShownArtifacts(message: Message, input: RecoverInput): Promise<Message> {
  const previous = input.previous.get(String(message.info.id)) ?? [];
  let changed = false;
  const parts: Part[] = [];
  for (const [index, part] of message.parts.entries()) {
    const state = isRecord(part) && part.type === 'tool' && SHOWN_TOOLS.has(normalizeToolName(part.tool))
      ? part.state
      : undefined;
    // Only a SETTLED show: a running call may still be writing its file.
    if (!isRecord(state) || state.status !== 'completed' || !isRecord(state.input)) {
      parts.push(part);
      continue;
    }
    const prior = part.id ? previous.find((value) => value.id === part.id) : previous[index];
    const priorInput = isRecord(prior?.state) && isRecord(prior.state.input) ? prior.state.input : undefined;
    const recovered = await recoverShowPayload(
      state.input,
      priorInput,
      `${message.info.id}:${part.id ?? index}`,
      'show',
      input,
    );
    if (recovered === state.input) {
      parts.push(part);
      continue;
    }
    changed = true;
    parts.push({ ...part, state: { ...state, input: recovered } });
  }
  return changed ? { ...message, parts } : message;
}

export async function recoverTranscriptAttachments(input: RecoverInput): Promise<Message[]> {
  const output: Message[] = [];
  for (const raw of input.messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const message = raw as Message;
    if (
      !message.info ||
      typeof message.info.id !== 'string' ||
      !message.info.id.trim() ||
      !Array.isArray(message.parts)
    )
      continue;
    if (message.info.role !== 'user') {
      output.push(
        message.info.role === 'assistant' ? await recoverShownArtifacts(message, input) : message,
      );
      continue;
    }
    const previous = input.previous.get(String(message.info.id)) ?? [];
    const parts: Part[] = [];
    for (const [index, part] of message.parts.entries()) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const identity = `${message.info.id}:${part.id ?? index}`;
      const prior = part.id ? previous.find((value) => value.id === part.id) : previous[index];
      const save = (
        source: string,
        filename: string,
        mime: string,
        suffix: string,
        previousUrl?: unknown,
      ) => saveRecovered(input, identity, source, filename, mime, suffix, previousUrl);
      if (
        part.type === 'file' &&
        typeof part.url === 'string' &&
        !parseSessionAttachmentRef(part.url)
      ) {
        const url = await save(
          part.url,
          String(part.filename || 'File'),
          String(part.mime || 'application/octet-stream'),
          'file',
          prior?.url,
        );
        parts.push(url ? { ...part, url } : part);
      } else if (part.type === 'text' && typeof part.text === 'string') {
        // `fileTagBlocks`, not a regex: the regex this replaced was quadratic in
        // user-controlled text and ran on the API's event loop here, at every
        // capture — see `@kortix/shared/file-tags`.
        const priorTags = fileTagBlocks(String(prior?.text ?? ''));
        let text = '';
        let end = 0;
        let ordinal = 0;
        for (const block of fileTagBlocks(part.text)) {
          const attrs = block.attrs;
          const whole = part.text.slice(block.index, block.end);
          const source = attribute(attrs, 'path');
          const existing = attribute(attrs, 'attachment');
          let replacement = whole;
          if (source && !parseSessionAttachmentRef(existing)) {
            const url = await save(
              source,
              attribute(attrs, 'filename') || path.posix.basename(source),
              attribute(attrs, 'mime') || 'application/octet-stream',
              String(ordinal),
              attribute(priorTags[ordinal]?.attrs ?? '', 'attachment'),
            );
            if (url)
              replacement = replacement.replace(
                /<file\s[^>]*>/,
                (tag) => existing !== undefined
                  ? tag.replace(/\sattachment="[^"]*"/, ` attachment="${url}"`)
                  : `${tag.slice(0, -1)} attachment="${url}">`,
              );
          }
          text += part.text.slice(end, block.index) + replacement;
          end = block.end;
          ordinal++;
        }
        parts.push({ ...part, text: text + part.text.slice(end) });
      } else parts.push(part);
    }
    output.push({ ...message, parts });
  }
  return output;
}
