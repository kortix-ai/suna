/**
 * Size limits for in-app file previews.
 *
 * A preview copies a file several times on the JS thread (string, data URL,
 * HTML template, WebView bridge), so large sandbox files are refused or
 * truncated before they reach a renderer. The Download action stays available
 * for every file.
 */

import type { FilePreviewType } from '@/components/files/FilePreviewRenderers';

const KB = 1024;
const MB = 1024 * KB;

/** Text-like files at or below this size render in full. */
export const TEXT_PREVIEW_MAX_BYTES = 1 * MB;
/** Text-like files at or below this size render truncated; larger ones are refused. */
export const TEXT_TRUNCATE_MAX_BYTES = 5 * MB;
/** How much of a truncated text file is displayed. */
export const TEXT_TRUNCATE_DISPLAY_BYTES = 200 * KB;
/** Binary files (image, PDF, DOCX, spreadsheet) at or below this size are previewed. */
export const BINARY_PREVIEW_MAX_BYTES = 15 * MB;
/** JSON is parsed and pretty-printed only below this length. */
export const JSON_PRETTY_PRINT_MAX_CHARS = 1 * MB;
/** CSV preview renders at most this many columns. */
export const CSV_MAX_COLUMNS = 50;

export type PreviewDecision = 'preview' | 'truncate' | 'too-large';

// FilePreviewType values that are fetched as a blob instead of text.
const BINARY_PREVIEW_TYPES: ReadonlySet<string> = new Set(['image', 'pdf', 'docx', 'xlsx', 'binary']);

/**
 * Decides how a file of `size` bytes is previewed. An unknown size previews,
 * because the directory listing does not always report one.
 */
export function previewDecision({
  size,
  previewType,
}: {
  size: number | null | undefined;
  previewType: FilePreviewType;
}): PreviewDecision {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return 'preview';

  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    return size <= BINARY_PREVIEW_MAX_BYTES ? 'preview' : 'too-large';
  }
  if (size <= TEXT_PREVIEW_MAX_BYTES) return 'preview';
  if (size <= TEXT_TRUNCATE_MAX_BYTES) return 'truncate';
  return 'too-large';
}

/**
 * Cuts text to the truncated display length. String length (UTF-16 code
 * units) approximates bytes; the cut never splits a surrogate pair.
 */
export function truncateForPreview(content: string): { text: string; truncated: boolean } {
  if (content.length <= TEXT_TRUNCATE_DISPLAY_BYTES) return { text: content, truncated: false };
  let end = TEXT_TRUNCATE_DISPLAY_BYTES;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: content.slice(0, end), truncated: true };
}
