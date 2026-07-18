/**
 * Pure show-type resolution helpers, extracted from `show-content-renderer.tsx`
 * so they can be unit-tested without pulling in the renderer's heavy React /
 * Next.js dependency graph.
 */

// ── Extension regexes ──────────────────────────────────────────────────────

export const SHOW_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;
export const SHOW_VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i;
export const SHOW_AUDIO_EXT_RE = /\.(mp3|wav|ogg|aac|flac|m4a|opus|wma)$/i;
export const SHOW_PDF_EXT_RE = /\.pdf$/i;
export const SHOW_CSV_EXT_RE = /\.(csv|tsv)$/i;
export const SHOW_XLSX_EXT_RE = /\.xlsx?$/i;
export const SHOW_DOCX_EXT_RE = /\.docx$/i;
export const SHOW_PPTX_EXT_RE = /\.(pptx|ppt)$/i;
export const SHOW_HTML_EXT_RE = /\.(html?|htm)$/i;

/** Auto-detect file category from extension — used when type='file'. */
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

/**
 * Rich (non-textual) categories a file path can resolve to. When a declared
 * type is textish but the path points at one of these, the path wins — an agent
 * that labels a `.csv`/`.xlsx`/`.docx`/`.pdf` as `markdown`/`text` should still
 * get the proper viewer rather than flowing prose.
 */
const RICH_SHOW_CATEGORIES = new Set([
  'image',
  'video',
  'audio',
  'pdf',
  'csv',
  'xlsx',
  'docx',
  'pptx',
  'html-file',
]);

/**
 * Declared types that are "textish" enough to be overridden by a richer file
 * extension. Explicit non-textual declarations (`image`, `video`, `url`,
 * `html`, `audio`, `error`, …) are left untouched.
 */
const TEXTISH_SHOW_TYPES = new Set(['file', 'text', 'markdown', 'code']);

/**
 * Resolve the effective render type for a show item.
 *
 * - When the declared `type` is textish AND the `path` extension maps to a rich
 *   category (image/video/audio/pdf/csv/xlsx/docx/pptx/html-file), the
 *   extension wins.
 * - `type: 'file'` keeps its existing auto-detect behaviour (a bare `file` with
 *   no rich extension stays `file`, so it still routes to the generic file
 *   viewer instead of being downgraded).
 * - Everything else (explicit `image`/`url`/`html`/… declarations, empty paths,
 *   non-rich extensions like `.md`/`.py`) returns the declared type unchanged.
 */
export function resolveShowType(type: string, path: string): string {
  if (path && TEXTISH_SHOW_TYPES.has(type)) {
    const category = getShowFileCategory(path);
    if (RICH_SHOW_CATEGORIES.has(category)) return category;
  }
  return type;
}
