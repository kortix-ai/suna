/**
 * Pure show-type resolution helpers, extracted from `show-content-renderer.tsx`
 * so they can be unit-tested without pulling in the renderer's heavy React /
 * Next.js dependency graph.
 */

import { getFileCategory, getLanguageFromExt } from '@/features/file-viewer/preview-policy';

/**
 * File categories the `show` card has a viewer of its own for. The extension
 * table is the file viewer's (`getFileCategory`); the card only names what it
 * calls them. `html` is `html-file` here because a `show` item may also carry
 * inline `html` content.
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
  'mermaid',
]);

/** Auto-detect file category from extension — used when type='file'. */
export function getShowFileCategory(filePath: string): string {
  if (getLanguageFromExt(filePath) === 'mermaid') return 'mermaid';
  const category = getFileCategory(filePath);
  const showCategory = category === 'html' ? 'html-file' : category;
  return RICH_SHOW_CATEGORIES.has(showCategory) ? showCategory : 'file';
}

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
 *   category (image/video/audio/pdf/csv/xlsx/docx/pptx/html-file/mermaid), the
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

/**
 * Whether a show item must be rendered by reading the file off the sandbox
 * rather than from an inline `content` string.
 *
 * This is the rule that decides whether a `show` renders at all, so it is
 * stated once, here, instead of living inside a branch condition.
 *
 * The renderer used to gate its file branch on `type === 'file'` exactly. That
 * made rendering depend on which type string the agent happened to emit: a
 * `.md` shown as `type: 'markdown'` with a path and no inline content matched
 * the file branch (wrong type), then missed every content branch (no content),
 * and fell through to an empty box. Same for `.yaml` as `'code'`/`'text'`.
 * Identical inputs, opposite outcomes, decided by a label — which is why it
 * read as "sometimes it works".
 *
 * The honest rule has nothing to do with the declared type: if there is a
 * sandbox path and no inline content, the bytes on disk are the only thing
 * there is to show. `FileContentRenderer` does its own text/code/markdown
 * detection and binary fallback, so it is always the right destination.
 *
 * Call this only AFTER the rich branches (image/video/audio/pdf/csv/xlsx/
 * docx/pptx/html/mermaid) have had their turn — those have real viewers of their own
 * and must keep them.
 */
export function shouldRenderFromSandboxFile(sandboxPath: string | null, content: string): boolean {
  return !!sandboxPath && !content;
}
