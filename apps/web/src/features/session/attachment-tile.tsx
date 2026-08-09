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
import { getFileIcon, getFileType } from '@/lib/utils/file-utils';

/**
 * Every attachment is the same square tile — the picture if we have one, an
 * icon with the name in the bottom corner otherwise. One shape is the whole
 * idea: there is no rows-vs-tiles mode to pick, nothing reflows when a file
 * joins a message, and a filename's length can never set a tile's width.
 */
export const TILE_SURFACE =
  'border-border bg-background relative block size-20 shrink-0 overflow-hidden rounded-md border';

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
  const Icon = getFileIcon(getFileType(filename));
  return (
    <span className="flex size-full flex-col justify-between gap-1 p-2">
      {pending ? (
        <Loading className="text-muted-foreground size-5 shrink-0" variant="spokes" />
      ) : (
        <Icon className="text-muted-foreground size-5 shrink-0" />
      )}
      <span className="text-foreground line-clamp-2 text-left text-xs leading-tight break-all">
        {filename}
      </span>
    </span>
  );
}
