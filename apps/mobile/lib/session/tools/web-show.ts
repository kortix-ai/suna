/**
 * Pure logic behind `components/session/tool/tools/show-tool.tsx` and its
 * content pieces (`show-content-renderer.tsx`, `show-carousel.tsx`).
 *
 * Ported from apps/web:
 * - `features/file-renderers/show-type-utils.ts` (extension regexes,
 *   `resolveShowType`, `shouldRenderFromSandboxFile`);
 * - `features/file-renderers/show-content-renderer.tsx` (the render cascade as
 *   `showContentBranch`, `showAspectRatioToCSS` as a number, carousel pill
 *   labels);
 * - `tool/tools/show-tool.tsx` (items parsing, header label and glyph, the one
 *   inline toolbar, the body state, the preview target).
 */

import { buildStaticFileLocalUrl, isAppRouteUrl, parseLocalhostUrl } from '@kortix/sdk';
import { isLocalSandboxFilePath } from '../tool-part-accessors';
import { safeHttpUrl } from './web-fetch';

// ─── Type resolution ─────────────────────────────────────────────────────────

export const SHOW_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;
export const SHOW_VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i;
export const SHOW_AUDIO_EXT_RE = /\.(mp3|wav|ogg|aac|flac|m4a|opus|wma)$/i;
export const SHOW_PDF_EXT_RE = /\.pdf$/i;
export const SHOW_CSV_EXT_RE = /\.(csv|tsv)$/i;
export const SHOW_XLSX_EXT_RE = /\.xlsx?$/i;
export const SHOW_DOCX_EXT_RE = /\.docx$/i;
export const SHOW_PPTX_EXT_RE = /\.(pptx|ppt)$/i;
export const SHOW_HTML_EXT_RE = /\.(html?|htm)$/i;

export function getShowFileCategory(filePath: string): string {
  if (SHOW_IMAGE_EXT_RE.test(filePath)) return 'image';
  if (SHOW_VIDEO_EXT_RE.test(filePath)) return 'video';
  if (SHOW_AUDIO_EXT_RE.test(filePath)) return 'audio';
  if (SHOW_PDF_EXT_RE.test(filePath)) return 'pdf';
  if (SHOW_CSV_EXT_RE.test(filePath)) return 'csv';
  if (SHOW_XLSX_EXT_RE.test(filePath)) return 'xlsx';
  if (SHOW_DOCX_EXT_RE.test(filePath)) return 'docx';
  if (SHOW_PPTX_EXT_RE.test(filePath)) return 'pptx';
  if (SHOW_HTML_EXT_RE.test(filePath)) return 'html-file';
  return 'file';
}

const RICH_SHOW_CATEGORIES = new Set(['image', 'video', 'audio', 'pdf', 'csv', 'xlsx', 'docx', 'pptx', 'html-file']);
const TEXTISH_SHOW_TYPES = new Set(['file', 'text', 'markdown', 'code']);

/** A textish declaration is upgraded when the path names a rich file type. */
export function resolveShowType(type: string, path: string): string {
  if (path && TEXTISH_SHOW_TYPES.has(type)) {
    const category = getShowFileCategory(path);
    if (RICH_SHOW_CATEGORIES.has(category)) return category;
  }
  return type;
}

/** A sandbox path with no inline content renders from the file on disk. */
export function shouldRenderFromSandboxFile(sandboxPath: string | null, content: string): boolean {
  return !!sandboxPath && !content;
}

/** `"16:9"` → 16/9; `auto` or malformed → undefined. */
export function parseShowAspectRatio(ar: string | undefined): number | undefined {
  if (!ar || ar === 'auto') return undefined;
  const [w, h] = ar.split(':').map(Number);
  return w && h ? w / h : undefined;
}

export function showDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return url;
  }
}

/**
 * Mobile-only: a sandbox file the inline text read must skip. The sandbox
 * returns such a file base64-encoded, which is not something to print; the
 * card offers the file viewer instead. Media and documents never reach the
 * text read (their branches come first in the cascade).
 */
const SHOW_BINARY_EXT_RE =
  /\.(zip|tar|gz|tgz|bz2|xz|rar|7z|jar|exe|dll|so|dylib|bin|dat|dmg|iso|img|woff2?|ttf|otf|eot|sqlite3?|db|pyc|class|o|a|wasm|psd|ai|sketch|fig|key|numbers|pages|odt|ods|odp|rtf|doc|ppt)$/i;

export function isShowBinaryPath(path: string): boolean {
  return SHOW_BINARY_EXT_RE.test(path);
}

// ─── Render cascade ──────────────────────────────────────────────────────────

export type ShowContentBranch =
  | 'localhost'
  | 'html-file'
  | 'url'
  | 'url-unsafe'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'csv'
  | 'xlsx'
  | 'docx'
  | 'pptx'
  | 'sandbox-file'
  | 'code'
  | 'markdown'
  | 'text'
  | 'html'
  | 'error'
  | 'fallback';

/**
 * Which branch of web's `ShowContentRenderer` a show item takes, in web's
 * order. Mobile renders every branch; image and video also accept a URL
 * (web requires a sandbox path for those two).
 */
export function showContentBranch({
  type,
  path,
  url,
  content,
}: {
  type: string;
  path: string;
  url: string;
  content: string;
}): ShowContentBranch {
  const effectiveType = resolveShowType(type, path);
  const hasLocalhostUrl = !!parseLocalhostUrl(url) && !isAppRouteUrl(url);
  const sandboxPath = path && isLocalSandboxFilePath(path) ? path : null;

  if (hasLocalhostUrl) return 'localhost';
  if ((effectiveType === 'html-file' || (effectiveType === 'html' && !content)) && sandboxPath) return 'html-file';
  if (effectiveType === 'url' && url) return safeHttpUrl(url) ? 'url' : 'url-unsafe';
  if (effectiveType === 'image' && (path || safeHttpUrl(url))) return 'image';
  if (effectiveType === 'video' && (path || safeHttpUrl(url))) return 'video';
  if (effectiveType === 'audio' && path) return 'audio';
  if (effectiveType === 'pdf' && path) return 'pdf';
  if (effectiveType === 'csv' && (path || content)) return 'csv';
  if (effectiveType === 'xlsx' && sandboxPath) return 'xlsx';
  if (effectiveType === 'docx' && path) return 'docx';
  if (effectiveType === 'pptx' && path) return 'pptx';
  if (shouldRenderFromSandboxFile(sandboxPath, content)) return 'sandbox-file';
  if (effectiveType === 'code' && content) return 'code';
  if (effectiveType === 'markdown' && content) return 'markdown';
  if (effectiveType === 'text' && content) return 'text';
  if (effectiveType === 'html' && content) return 'html';
  if (effectiveType === 'error' && content) return 'error';
  return 'fallback';
}

// ─── show tool ───────────────────────────────────────────────────────────────

export interface ShowCarouselItem {
  type: string;
  title?: string;
  description?: string;
  path?: string;
  url?: string;
  content?: string;
  language?: string;
  aspect_ratio?: string;
}

/** `input.items` as an array (or a JSON string of one); `null` when empty or invalid. */
export function parseShowItems(raw: unknown): ShowCarouselItem[] | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as ShowCarouselItem[];
  } catch {
    // invalid JSON
  }
  return null;
}

/**
 * The header label: the title, else a safe fallback — never a raw path or an
 * unsafe URL (a relative URL degrades to "Link").
 */
export function showDisplayTitle({
  isCarousel,
  itemCount,
  title,
  type,
  url,
}: {
  isCarousel: boolean;
  itemCount: number;
  title: string;
  type: string;
  url: string;
}): string {
  if (isCarousel) return title || `${itemCount} items`;
  if (title) return title;
  if (type === 'error') return 'Error';
  if (type === 'url') {
    const safe = safeHttpUrl(url);
    return (safe ? showDomain(safe) : '') || 'Link';
  }
  return 'Output';
}

/** The single header glyph's type: the active carousel item, a preview, or the show's type. */
export function showHeaderIconType({
  isCarousel,
  currentItemType,
  isWebsitePreview,
  type,
}: {
  isCarousel: boolean;
  currentItemType: string;
  isWebsitePreview: boolean;
  type: string;
}): string {
  if (isCarousel) return currentItemType || 'image';
  return isWebsitePreview ? 'url' : type;
}

/** A localhost URL previews as itself; an HTML file through the static file server; else ''. */
export function resolveShowPreviewUrl({
  activeUrl,
  activePath,
  activeType,
}: {
  activeUrl: string;
  activePath: string;
  activeType: string;
}): string {
  const hasLocalhostUrl = !!parseLocalhostUrl(activeUrl) && !isAppRouteUrl(activeUrl);
  if (hasLocalhostUrl) return activeUrl;
  const isHtmlFilePath =
    !!activePath && SHOW_HTML_EXT_RE.test(activePath) && (activeType === 'file' || activeType === 'html');
  return isHtmlFilePath ? buildStaticFileLocalUrl(activePath) : '';
}

export type ShowInlineToolbarKind = 'preview' | 'file' | 'content-preview' | null;

/** The one toolbar in the inline card header. */
export function showInlineToolbarKind({
  isWebsitePreview,
  activePath,
  isCarousel,
  content,
  canActivate,
  navigationEnabled,
}: {
  isWebsitePreview: boolean;
  activePath: string;
  isCarousel: boolean;
  content: string;
  canActivate: boolean;
  navigationEnabled: boolean;
}): ShowInlineToolbarKind {
  if (isWebsitePreview) return 'preview';
  if (activePath) return 'file';
  if (!isCarousel && content && canActivate && navigationEnabled) return 'content-preview';
  return null;
}

export type ShowBodyKind = 'hidden' | 'loading' | 'unavailable' | 'content';

export function showBodyKind({
  running,
  type,
  hasItems,
  hasNothingToShow,
  unavailable,
}: {
  running: boolean;
  type: string;
  hasItems: boolean;
  hasNothingToShow: boolean;
  unavailable: boolean;
}): ShowBodyKind {
  if (!running && hasNothingToShow) return 'hidden';
  if (running && !type && !hasItems) return 'loading';
  if (unavailable) return 'unavailable';
  return 'content';
}

export function showUnavailableLabel(displayTitle: string): string {
  return `Preview unavailable${displayTitle ? ` — ${displayTitle}` : ''}`;
}

// ─── Carousel ────────────────────────────────────────────────────────────────

const SHOW_TYPE_LABELS: Record<string, string> = {
  file: 'File',
  image: 'Image',
  url: 'URL',
  text: 'Text',
  error: 'Error',
  video: 'Video',
  audio: 'Audio',
  code: 'Code',
  markdown: 'Markdown',
  pdf: 'PDF',
  html: 'HTML',
  csv: 'CSV',
  xlsx: 'Sheet',
  docx: 'Doc',
  pptx: 'Slides',
};

const SHOW_DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)$/i;
const SHOW_DOC_TYPE_RE = /^(pdf|docx?|pptx?|xlsx?)$/i;

function getShowDocExt(item: ShowCarouselItem): string | null {
  const match = item.path?.match(SHOW_DOC_EXT_RE);
  if (match) return match[1].toLowerCase();
  const type = item.type ?? '';
  return SHOW_DOC_TYPE_RE.test(type) ? type.toLowerCase() : null;
}

function truncateLabel(value: string, max = 18): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Short pill label — port, document extension, title, domain, basename, or type. */
export function getShowCarouselItemLabel(item: ShowCarouselItem): string {
  const localhost = item.url ? parseLocalhostUrl(item.url) : null;
  if (localhost && !isAppRouteUrl(item.url)) return `:${localhost.port}`;

  const docExt = getShowDocExt(item);
  if (docExt) return docExt.toUpperCase();

  if (item.title?.trim()) return truncateLabel(item.title.trim());

  if (item.url) {
    const external = safeHttpUrl(item.url);
    if (external) return truncateLabel(showDomain(external));
  }

  if (item.path) {
    const base = item.path.split('/').filter(Boolean).pop();
    if (base) return truncateLabel(base);
  }

  return SHOW_TYPE_LABELS[item.type] ?? truncateLabel(item.type || 'Item');
}

export function getShowCarouselItemAriaLabel(
  item: ShowCarouselItem,
  index: number,
  total: number,
  itemLabel: string,
): string {
  const parts = [`Item ${index + 1} of ${total}`];
  parts.push(item.title || itemLabel);
  if (item.type) parts.push(item.type);
  return parts.join(' · ');
}
