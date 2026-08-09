'use client';

/**
 * The composer's attachment preview — the same square tile the sent message
 * uses (`FileTileBody` / `TILE_SURFACE` in `../attachment-tile`), plus the two
 * things a not-yet-sent file needs that a sent one never does: a corner
 * remove button, and — since there is no server thumbnail yet — a client-side
 * peek at what the file actually contains.
 *
 * Replaces `attachment-preview.tsx`'s 120px name-bar card, which looked
 * nothing like how the same file rendered a moment later once the message
 * sent. That file is not deleted yet: `session-chat-input.tsx` still renders
 * it, and swapping the call site is Task 13's job once every consumer of the
 * old shape moves in one change.
 */

import { useEffect, useState } from 'react';

import { XIcon as X } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { convertHeicBlobToJpeg, isHeicFile } from '@/lib/utils/heic-convert';

import { FileTileBody, TILE_INTERACTIVE, TILE_SURFACE } from '../attachment-tile';
import {
  fileExtension,
  isPreviewableTextExtension,
  truncateTextPreview,
} from './attachment-tiles-logic';
import type { AttachedFile } from './types';

/** The two shapes of `AttachedFile` disagree on where the name lives. */
function attachmentName(af: AttachedFile): string {
  return af.kind === 'local' ? af.file.name : af.filename;
}

/**
 * A locally attached image.
 *
 * HEIC is decoded to JPEG first — browsers cannot render HEIC natively —
 * carried over verbatim from the old `attachment-preview.tsx`. The decode is
 * async, so until it resolves the tile falls back to the named treatment with
 * a spinner, matching how the sent message's own `AttachmentImage` handles a
 * src that has not resolved yet (`turn/user-message.tsx`).
 */
function AttachmentImageTile({ af, name }: { af: AttachedFile; name: string }) {
  const isHeic = isHeicFile(name);
  const [heicUrl, setHeicUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isHeic || af.kind !== 'local') return;
    let cancelled = false;
    let objectUrl: string | null = null;
    convertHeicBlobToJpeg(af.file)
      .then((jpeg) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(jpeg);
        setHeicUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `af` (not `af.file`) matches the dependency the original
    // `attachment-preview.tsx` HEIC effect tracked.
  }, [af, isHeic]);

  const src = isHeic ? heicUrl : af.kind === 'local' ? af.localUrl : af.url;

  if (!src) return <FileTileBody filename={name} pending />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={name} className="size-full object-cover" draggable={false} />
  );
}

/**
 * A locally attached non-image file: the named tile, with a faint peek at the
 * file's own first ~12 lines behind the icon when it is source/text (carried
 * over verbatim from the old `attachment-preview.tsx` — the sent message never
 * shows this, but before sending it is the difference between guessing which
 * `untitled.txt` is which and knowing).
 */
function AttachmentFileTile({ af, name }: { af: AttachedFile; name: string }) {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const ext = fileExtension(name);

  useEffect(() => {
    if (af.kind !== 'local' || !isPreviewableTextExtension(ext)) return;
    const reader = new FileReader();
    reader.onload = () => setTextPreview(truncateTextPreview(reader.result as string));
    reader.readAsText(af.file.slice(0, 2048));
  }, [af, ext]);

  return (
    <>
      {textPreview && (
        <div className="absolute inset-0 overflow-hidden p-2 opacity-40">
          <pre className="text-muted-foreground pointer-events-none m-0 overflow-hidden p-0 font-mono text-[7px] leading-[1.35] whitespace-pre select-none">
            {textPreview}
          </pre>
        </div>
      )}
      <FileTileBody filename={name} />
    </>
  );
}

export function AttachmentTiles({
  files,
  onRemove,
}: {
  files: AttachedFile[];
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((af, i) => {
        const name = attachmentName(af);
        return (
          <li key={i} className="group relative contents">
            <div title={name} className={cn(TILE_SURFACE, TILE_INTERACTIVE)}>
              {af.isImage ? (
                <AttachmentImageTile af={af} name={name} />
              ) : (
                <AttachmentFileTile af={af} name={name} />
              )}
            </div>
            <button
              type="button"
              onClick={() => onRemove(i)}
              aria-label={`Remove ${name}`}
              className={cn(
                'border-card absolute -top-1.5 -right-1.5 z-10 flex size-5 items-center justify-center',
                'rounded-full border-2 bg-black text-white dark:bg-white dark:text-black',
                'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
                '[@media(pointer:coarse)]:opacity-100',
              )}
            >
              <X className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
