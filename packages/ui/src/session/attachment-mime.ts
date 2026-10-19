/**
 * One extension → mime answer for every attachment surface.
 *
 * A browser is free to hand a `File` an empty `type`: `.md`, `.csv` and `.svg`
 * routinely arrive with `type === ''`, and some platforms do it for `.png` from
 * a drag-and-drop. The composer preview always coped — it sniffed the extension
 * (`composer/attachment-preview.tsx`) — but the transcript did not: it gates the
 * picture on `mime.startsWith('image/')`, and the upload ref recorded
 * `application/octet-stream` whenever `file.type` was empty. The same PNG was a
 * picture in the composer and a generic file icon in the transcript.
 *
 * Both surfaces now read this module, so an attachment's kind cannot depend on
 * which component is asking.
 */

/** Extensions a browser can paint. Also the composer thumbnail's image test. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'apng',
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
]);

/**
 * Extension → mime, for the types a chat attachment actually arrives as.
 *
 * Deliberately short: this exists to stop an empty `file.type` from erasing an
 * attachment's kind, not to become a copy of `mime-db`. Anything missing falls
 * through to `application/octet-stream`, which is the honest answer.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  // Images
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',

  // Documents
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  json: 'application/json',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  toml: 'text/plain',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',

  // Office
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // Audio / video
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'video/webm',

  // Archives
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  zip: 'application/zip',
};

/** The lowercase extension of `name`, or `''` when it has none. */
export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  // `dot <= 0` covers both "no dot" and a dotfile such as `.env`, neither of
  // which has an extension — `split('.').pop()` would hand back the whole name
  // and make `key` look like a Keynote file.
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** True when the name's extension is one a browser can paint. */
export function isImageExtension(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** The mime an extension implies, or `undefined` when we do not know it. */
export function mimeForFilename(name: string): string | undefined {
  return MIME_BY_EXTENSION[extensionOf(name)];
}

/**
 * The mime to record for an attachment.
 *
 * The browser's own `type` always wins. An empty one falls back to the
 * extension, and only an unknown extension yields `application/octet-stream`.
 */
export function attachmentMime(type: string | undefined, filename: string): string {
  if (type && type.trim()) return type;
  return mimeForFilename(filename) ?? 'application/octet-stream';
}
