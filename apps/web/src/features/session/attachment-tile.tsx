'use client';

/**
 * THE attachment tile — one component for the composer preview, the sent
 * message, the boot stand-in and the queued row, so a file can never look one
 * way while it is being attached and another the moment it is sent.
 *
 * The shape (2026-09-06, from Jay's reference): a square. A named file shows
 * its name top-left over two lines and its extension as a badge bottom-left.
 * An image IS the picture, edge to edge, with the same badge over its corner.
 * No icon: the extension badge says what the file is, and the name says which
 * one. There is no rows-vs-tiles mode and no second rectangle shape — the
 * earlier 120px "file rectangle" beside 80px "image squares" gave every
 * message a ragged right edge.
 *
 * Every value is a token (`kortix-brand-guidelines`): `size-24` on the 0.23rem
 * scale (~88px), `rounded-md`, the one `border-border` hairline, `bg-popover`
 * as the lifted-surface fill, `text-xs` for the name. The badge is the design
 * system's `Badge` at `size="xs"`, uppercase — the note at the badge says why.
 */

import { Badge } from '@/components/ui/badge';
import Loading from '@/components/ui/loading';
import { Close } from '@/features/icon/icons/close';
import { cn } from '@/lib/utils';

/** The square every attachment is. `size-28` (~103px on the 0.23rem scale) —
 *  Jay's call, 2026-09-06: the 88px square read as cramped beside the name. */
export const TILE_SURFACE =
  'border-border bg-popover relative block size-28 shrink-0 overflow-hidden rounded-md border text-left';

/**
 * The press/hover feel a tile gets ONLY when pressing it does something (opens
 * the file, opens the lightbox). A tile with no handler carries no promise.
 */
export const TILE_INTERACTIVE =
  'hover:bg-accent cursor-pointer transition-colors duration-fast active:scale-[0.96]';

/**
 * Which files the tile shows AS A PICTURE. Raster images only. An SVG is text
 * that happens to draw — a logo file on a tile is a black blob at 100px, and
 * its name is what tells it from the next logo file (Jay, 2026-09-06). It
 * gets the named treatment, badge and all.
 */
export function isPreviewableImage(filename: string, mime?: string): boolean {
  const ext = attachmentExtension(filename, mime);
  if (ext === 'svg') return false;
  return (mime ?? '').toLowerCase().startsWith('image/');
}

/** What the tile prints in the file's corner. Lowercase, from the name first
 *  and the MIME subtype second; empty when neither says anything. */
export function attachmentExtension(filename: string, mime?: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1).trim().toLowerCase();
    if (ext.length > 0 && ext.length <= 8 && !/\s/.test(ext)) return ext;
  }
  const subtype = (mime ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!subtype) return '';
  // `svg+xml` → `svg`, `x-icon` → `icon`, `vnd.ms-excel` → `excel`.
  return subtype.split('+')[0]!.replace(/^x-/, '').split('.').pop() ?? '';
}

/**
 * How a name is laid out on the tile.
 *
 * A short name wraps over two lines as the browser sees fit. A long one is
 * split: the first line is the head, ellipsized by CSS at the tile's edge, and
 * the second line is the last ten characters verbatim — the part that carries
 * the extension and tells `…-chatux.md` from `…-ux.md`. A single middle
 * ellipsis in one string wrapped wherever the browser chose, and left a
 * dangling hyphen at the end of line one (2026-09-06).
 */
export const LONG_NAME_THRESHOLD = 24;
export const NAME_TAIL_CHARS = 10;

export function splitFilenameForTile(name: string): { head: string; tail: string } | null {
  if (name.length <= LONG_NAME_THRESHOLD) return null;
  return { head: name.slice(0, -NAME_TAIL_CHARS), tail: name.slice(-NAME_TAIL_CHARS) };
}

/** The one-string form, for places that cannot render two lines (tooltips, tests). */
export function middleTruncateFilename(name: string, max = 22): string {
  if (name.length <= max) return name;
  const tail = Math.min(NAME_TAIL_CHARS, Math.floor((max - 1) / 2));
  const head = max - 1 - tail;
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}

export interface AttachmentTileProps {
  filename: string;
  mime?: string;
  /** A resolved image source (`data:`, `blob:`, `https:`). When present the
   *  tile is the picture; the badge sits over its corner. */
  imageSrc?: string | null;
  /** Bytes still on their way — a spinner takes the corner opposite the badge. */
  pending?: boolean;
  /** Pressing the tile does this. Without it the tile is inert and says so. */
  onOpen?: () => void;
  className?: string;
  title?: string;
}

export function AttachmentTile({
  filename,
  mime,
  imageSrc,
  pending = false,
  onOpen,
  className,
  title,
}: AttachmentTileProps) {
  const ext = attachmentExtension(filename, mime);
  const split = splitFilenameForTile(filename);
  // Uppercase, and that is what centres it. The badge centres the font's
  // content area — Roobert Mono ascends 1.016em and descends 0.234em, so that
  // middle sits 0.39em above the baseline, which is where the middle of a
  // capital is (cap height 0.70em). Lowercase only reaches the x-height
  // (0.50em): its body sits 0.1em ≈ 1.3px low at this size, and a descender
  // drags the ink another 1.3px down, so "svg" read visibly low (Jay,
  // 2026-09-06). Measured in Chromium at 2x: caps +0.2px off centre, "sv"
  // +1.5px, "svg" +2.7px. The `secondary` variant is `normal-case`; the
  // `uppercase` here wins in `cn`. The text stays lowercase in the DOM.
  const badge = ext ? (
    <Badge variant="secondary" size="xs" className="font-medium uppercase">
      {ext}
    </Badge>
  ) : null;
  const surface = cn(TILE_SURFACE, onOpen && TILE_INTERACTIVE, className);
  const tileTitle = title ?? filename;

  // A picture is the whole tile: no badge over it. The image says what it is
  // better than `png` could, and a chip on a photo's corner is clutter.
  const picture = imageSrc && isPreviewableImage(filename, mime) ? imageSrc : null;
  const body = picture ? (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={picture} alt={filename} className="size-full object-cover" draggable={false} />
      {pending && <Loading className="text-muted-foreground absolute right-2 bottom-2 size-4" />}
    </>
  ) : (
    <>
      <span className="flex size-full flex-col justify-between gap-1 p-2">
        {/* `min-w-0` so the clamp can ellipsize; never `truncate` (nowrap
            defeats the two-line wrap). */}
        {split ? (
          <span className="text-foreground min-w-0 text-xs leading-tight font-medium">
            <span className="block truncate">{split.head}</span>
            <span className="block truncate">{split.tail}</span>
          </span>
        ) : (
          <span className="text-foreground min-w-0 line-clamp-2 text-xs leading-tight font-medium break-all">
            {filename}
          </span>
        )}
        <span className="flex items-end justify-between gap-1">
          {badge ?? <span />}
          {pending && <Loading className="text-muted-foreground size-4 shrink-0" />}
        </span>
      </span>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        title={tileTitle}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className={surface}
      >
        {body}
      </button>
    );
  }
  return (
    <span title={tileTitle} className={surface}>
      {body}
    </span>
  );
}

/**
 * The composer's corner "remove" control — a sibling of the tile, never a
 * child: the tile is `overflow-hidden` and the dot sits half outside its edge.
 */
export function AttachmentRemoveButton({
  filename,
  onRemove,
}: {
  filename: string;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${filename}`}
      className={cn(
        'border-card absolute -top-1.5 -right-1.5 z-10 flex size-5 items-center justify-center',
        'bg-foreground text-background rounded-full border-2',
        'hit-area-1',
        // Hidden at rest, revealed by hovering the tile (Jay, 2026-09-06). It
        // stays reachable where hover does not exist: keyboard focus, and
        // touch — a coarse pointer shows it always.
        'opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100',
        '[@media(pointer:coarse)]:opacity-100',
      )}
    >
      <Close className="size-3" />
    </button>
  );
}
