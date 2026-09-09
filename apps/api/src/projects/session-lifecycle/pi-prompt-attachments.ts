import { createHash } from 'node:crypto';
import { remainingRequestBudgetMs } from '../../middleware/request-deadline';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../lib/session-attachment-input';
import { parseStagedPromptDataUrl } from './prompt-attachment-materializer';
import { readRemotePiImage } from './pi-remote-image';
import type { PromptPartWire } from './store';

export interface StagedSessionAttachment {
  sha256: string;
  contentType: string;
  content: Buffer;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const REFERENCE = /^kortix-attachment:sha256:[a-f0-9]{64}$/;
const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024;

type PreparedImage = { part: PromptPartWire; content?: Buffer; remoteUrl?: string };

export async function preparePiPromptAttachments(
  parts: PromptPartWire[],
  options: { allowReferences?: boolean; signal?: AbortSignal } = {},
): Promise<{ parts: PromptPartWire[]; attachments: StagedSessionAttachment[] }> {
  let count = 0;
  let inlineSize = 0;
  const images = parts.map((part): PreparedImage => {
    if (part.type === 'text') return { part };
    if (part.type !== 'file' || !IMAGE_TYPES.has(part.mime ?? ''))
      throw new Error('Pi prompts accept text and PNG, JPEG, GIF, or WebP images');
    if (++count > 16) throw new Error('Pi prompts accept up to 16 images');
    if (
      part.source !== undefined ||
      part.filename?.includes('\0') ||
      (part.filename?.length ?? 0) > 255
    )
      throw new Error('invalid Pi image attachment metadata');
    if (REFERENCE.test(part.url ?? '')) {
      if (!options.allowReferences)
        throw new Error('upload image bytes when creating a new session');
      return { part };
    }
    if (part.url?.toLowerCase().startsWith('data:')) {
      const { bytes } = parseStagedPromptDataUrl(part);
      if (bytes.byteLength === 0) throw new Error('image attachment is empty');
      if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES)
        throw new Error('image attachment exceeds 8 MiB');
      inlineSize += bytes.byteLength;
      if (inlineSize > MAX_PROMPT_IMAGE_BYTES)
        throw new Error('Pi image attachments exceed 16 MiB');
      return { part, content: Buffer.from(bytes) };
    }
    let url: URL;
    try {
      url = new URL(part.url ?? '');
    } catch {
      throw new Error('remote images require a safe public HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192)
      throw new Error('remote images require a safe public HTTPS URL');
    return { part, remoteUrl: url.href };
  });

  const timeoutMs = remainingRequestBudgetMs(20_000);
  if (timeoutMs === 0 && images.some(image => image.remoteUrl))
    throw new Error('remote image download cancelled or timed out');
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const downloads = new Map<string, Buffer>();
  const attachments = new Map<string, StagedSessionAttachment>();
  const prepared: PromptPartWire[] = [];
  let size = 0;
  for (const image of images) {
    const { part, remoteUrl } = image;
    let content = image.content;
    if (remoteUrl) {
      const key = JSON.stringify([remoteUrl, part.mime]);
      content = downloads.get(key);
      if (!content) {
        content = await readRemotePiImage(remoteUrl, part.mime!, signal);
        downloads.set(key, content);
      }
    }
    if (!content) {
      prepared.push(part);
      continue;
    }
    size += content.byteLength;
    if (size > MAX_PROMPT_IMAGE_BYTES) throw new Error('Pi image attachments exceed 16 MiB');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const existing = attachments.get(sha256);
    if (existing && existing.contentType !== part.mime)
      throw new Error('attachment bytes and MIME type are immutable');
    attachments.set(sha256, { sha256, contentType: part.mime!, content });
    prepared.push({
      type: 'file',
      mime: part.mime,
      url: `kortix-attachment:sha256:${sha256}`,
      ...(part.filename === undefined ? {} : { filename: part.filename }),
    });
  }
  return { parts: prepared, attachments: [...attachments.values()] };
}
