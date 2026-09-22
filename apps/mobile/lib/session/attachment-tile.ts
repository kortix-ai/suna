/**
 * Attachment tile logic — a port of the pure parts of apps/web
 * `features/session/attachment-tile.tsx` and `planAttachmentGrid` in
 * `features/session/turn/user-message.tsx`. `components/session/attachment-tile.tsx`
 * owns how a tile looks.
 */

/** Lowercase extension from the name first, the MIME subtype second; `''` when neither says anything. */
export function attachmentExtension(filename: string, mime?: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).trim().toLowerCase();
    if (ext.length > 0 && ext.length <= 8 && !/\s/.test(ext)) return ext;
  }
  const subtype = (mime ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!subtype) return '';
  // `svg+xml` → `svg`, `x-icon` → `icon`, `vnd.ms-excel` → `ms-excel`.
  return subtype.split('+')[0]!.replace(/^x-/, '').split('.').pop() ?? '';
}

/** Raster images only. An SVG gets the named tile: at 103px a logo is a blob, and its name tells it apart. */
export function isPreviewableImage(filename: string, mime?: string): boolean {
  if (attachmentExtension(filename, mime) === 'svg') return false;
  return (mime ?? '').toLowerCase().startsWith('image/');
}

export const LONG_NAME_THRESHOLD = 24;
export const NAME_TAIL_CHARS = 10;

/**
 * A long name shows as two lines: the head (ellipsized at the tile edge) and
 * the last 10 characters verbatim, which carry the extension.
 */
export function splitFilenameForTile(name: string): { head: string; tail: string } | null {
  if (name.length <= LONG_NAME_THRESHOLD) return null;
  return { head: name.slice(0, -NAME_TAIL_CHARS), tail: name.slice(-NAME_TAIL_CHARS) };
}

/** Tiles in a sent message before the strip collapses into a `+N` tile. */
export const ATTACHMENT_TILE_CAP = 8;

export interface AttachmentGridPlan<T> {
  visible: T[];
  /** Attachments behind the `+N` tile; 0 when there is no overflow tile. */
  overflowCount: number;
}

/**
 * Past the cap, `cap - 1` tiles show and the last slot is the `+N` tile, so
 * the strip is never more than `cap` tiles. `overflowCount` counts every
 * attachment not drawn. (apps/web reports `length - cap`, one fewer than it
 * hides, because its `+N` tile covers the 8th attachment.)
 */
export function planAttachmentGrid<T>(items: readonly T[], expanded: boolean): AttachmentGridPlan<T> {
  if (expanded || items.length <= ATTACHMENT_TILE_CAP) {
    return { visible: [...items], overflowCount: 0 };
  }
  const shown = ATTACHMENT_TILE_CAP - 1;
  return { visible: items.slice(0, shown), overflowCount: items.length - shown };
}

/**
 * Where a message attachment's bytes come from. `data:` and `http(s):` URLs
 * load directly; a `file://` URL or a bare path is a file in the session
 * sandbox and loads through `useSandboxImage` (HEAD probe + tap-to-load limit).
 */
export function resolveAttachmentSource(
  src: string | undefined,
): { uri: string } | { path: string } | null {
  if (!src) return null;
  if (/^(data|https?):/i.test(src)) return { uri: src };
  if (/^file:\/\//i.test(src)) return { path: src.replace(/^file:\/\//i, '') };
  return { path: src };
}
