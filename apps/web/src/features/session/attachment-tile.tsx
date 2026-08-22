'use client';

/**
 * The one attachment tile — shared so the composer's preview and the sent
 * message can never drift apart.
 *
 * Before this module existed, `turn/user-message.tsx` had its own copy of
 * this shape (icon top, filename bottom, same 20×20 square) and the composer
 * had a completely different one (a 120px card with a separate name bar).
 * Extracting the shared pieces here — rather than pasting the same class
 * strings into both files — is what keeps "the preview looks like the sent
 * message" true after either file changes: tune the tile once, both surfaces
 * move together.
 *
 * Consumed by `turn/user-message.tsx` (the sent message) and
 * `composer/attachment-tiles.tsx` (the composer preview).
 */

import Loading from '@/components/ui/loading';
import { fileIconFor } from '@/lib/utils/file-utils';

/**
 * Every attachment is the same square tile — the picture if we have one, an
 * icon with the name in the bottom corner otherwise. One shape is the whole
 * idea: there is no rows-vs-tiles mode to pick, nothing reflows when a file
 * joins a message, and a filename's length can never set a tile's width.
 */
export const TILE_SURFACE =
  'border-border bg-background relative block size-20 shrink-0 overflow-hidden rounded-sm border';

/**
 * The OTHER shape: every non-image file — a wider rectangle, not the square.
 * A filename tile as narrow as the image square would either truncate to
 * nothing or force a name to wrap across more lines than the two-line clamp
 * allows, so non-image tiles get the extra width instead.
 *
 * `h-20 w-30` — 80px tall, 120px wide. That FIXED width is what makes
 * `line-clamp-2` fire: without a bound the tile grows to the filename's
 * max-content width and the ellipsis never appears. (It was written
 * `size-20 w-30`, which sets the width twice and left the real value depending
 * on stylesheet order rather than on the class list.)
 *
 * Kept as its own constant (not folded into `TILE_SURFACE`) for the same
 * reason `TILE_SURFACE` exists at all: one definition, shared by the sent
 * message and the composer preview, so a future edit to the file-tile shape
 * cannot land in one surface without the other.
 */
export const FILE_TILE_SURFACE =
  'border-border bg-background relative block h-20 w-30 shrink-0 overflow-hidden rounded-sm border';

/**
 * The press/hover feel every attachment tile shares — a file pill, an image
 * tile and a composer preview tile all answer the pointer the same way, so
 * the block reads as one set of controls rather than several.
 */
export const TILE_INTERACTIVE =
  'hover:bg-muted/50 cursor-pointer transition-colors active:scale-[0.97]';

/**
 * A named attachment: icon top-left, filename along the bottom.
 *
 * Two lines, bottom-aligned, because the name is the only thing distinguishing
 * one document from another — `AdmitCard-260411128971.pdf` truncated to a
 * single line is indistinguishable from its siblings.
 *
 * Takes a bare `filename` rather than a specific attachment shape, since the
 * composer's `AttachedFile` and the sent message's `NormalizedAttachment`
 * disagree on everything else (local `File` vs. remote URL, upload state,
 * mime) and this body only ever needed the name.
 */
export function FileTileBody({ filename, pending }: { filename: string; pending?: boolean }) {
  const Icon = fileIconFor(filename);
  return (
    // `min-w-0` is required on the flex column and the filename: flex items
    // default to `min-width: auto`, which refuses to shrink below the name's
    // max-content width — so a long name expands the tile instead of
    // clamping. With a bounded tile (`FILE_TILE_SURFACE`'s `w-30`) and
    // `min-w-0`, `line-clamp-2` can actually ellipsize.
    //
    // Do not add `truncate` here. It sets `white-space: nowrap`, which
    // overrides the wrap `line-clamp-2` needs and is the measured cause of
    // "ellipsis missing on long names" (tile grows; nothing clamps).
    //
    // `h-20 w-full`, not `size-20 w-full`: the latter set the width twice and
    // the file tile is 120px wide, not 80 — which of the two won was left to
    // stylesheet order.
    <span className="flex h-20 w-full flex-col justify-between gap-1 p-2">
      {pending ? (
        <Loading className="text-muted-foreground size-5 shrink-0" variant="spokes" />
      ) : (
        <Icon className="text-muted-foreground size-5 shrink-0" />
      )}
      <span className="text-foreground min-w-0 line-clamp-2 break-all text-left text-xs leading-tight">
        {filename}
      </span>
    </span>
  );
}
