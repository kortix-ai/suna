import path from 'node:path';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
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
const tags = () => /<file\s+([^>]*?)>\s*[\s\S]*?<\/file>/g;
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

export async function recoverTranscriptAttachments(input: {
  messages: unknown[];
  previous: Map<string, Part[]>;
  projectId: string;
  sessionId: string;
  recover: boolean;
  readFile: (path: string) => Promise<Uint8Array | null>;
  saveFile: (file: SavedFile) => Promise<{ url: string }>;
  onFailure: (filename: string, error: unknown) => void;
  signal?: AbortSignal;
}): Promise<Message[]> {
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
      output.push(message);
      continue;
    }
    const previous = input.previous.get(String(message.info.id)) ?? [];
    const parts: Part[] = [];
    for (const [index, part] of message.parts.entries()) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const identity = `${message.info.id}:${part.id ?? index}`;
      const prior = part.id ? previous.find((value) => value.id === part.id) : previous[index];
      const save = async (
        source: string,
        filename: string,
        mime: string,
        suffix: string,
        previousUrl?: unknown,
      ) => {
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
      };
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
        const priorTags = [...String(prior?.text ?? '').matchAll(tags())];
        let text = '';
        let end = 0;
        let ordinal = 0;
        for (const match of part.text.matchAll(tags())) {
          const attrs = match[1]!;
          const source = attribute(attrs, 'path');
          const existing = attribute(attrs, 'attachment');
          let replacement = match[0];
          if (source && !parseSessionAttachmentRef(existing)) {
            const url = await save(
              source,
              attribute(attrs, 'filename') || path.posix.basename(source),
              attribute(attrs, 'mime') || 'application/octet-stream',
              String(ordinal),
              attribute(priorTags[ordinal]?.[1] ?? '', 'attachment'),
            );
            if (url)
              replacement = replacement.replace(
                /<file\s+[^>]*>/,
                (tag) => existing !== undefined
                  ? tag.replace(/\sattachment="[^"]*"/, ` attachment="${url}"`)
                  : `${tag.slice(0, -1)} attachment="${url}">`,
              );
          }
          text += part.text.slice(end, match.index) + replacement;
          end = match.index! + match[0].length;
          ordinal++;
        }
        parts.push({ ...part, text: text + part.text.slice(end) });
      } else parts.push(part);
    }
    output.push({ ...message, parts });
  }
  return output;
}
