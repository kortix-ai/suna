'use client';

/**
 * The composer's attachment preview — the same tiles the sent message uses
 * (`FileTileBody` / `TILE_SURFACE` / `FILE_TILE_SURFACE` in
 * `../attachment-tile`), plus the two things a not-yet-sent file needs that a
 * sent one never does: a corner remove button, and — since there is no server
 * thumbnail yet — a client-side peek at what the file actually contains.
 *
 * Replaces `attachment-preview.tsx`'s 120px name-bar card, which looked
 * nothing like how the same file rendered a moment later once the message
 * sent. That file is not deleted yet: `session-chat-input.tsx` still renders
 * it, and swapping the call site is Task 13's job once every consumer of the
 * old shape moves in one change.
 */

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { convertHeicBlobToJpeg, isHeicFile } from '@/lib/utils/heic-convert';

import { FILE_TILE_SURFACE, FileTileBody, TILE_SURFACE } from '../attachment-tile';
import {
  fileExtension,
  isPreviewableTextExtension,
  truncateTextPreview,
} from './attachment-tiles-logic';
import type { AttachedFile } from './types';

/** The two shapes of `AttachedFile` disagree on where the name lives. */
import { Close } from '@/features/icon/icons/close';
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
 * Icon + filename in front, a faint peek at the file's own text behind —
 * split out from `AttachmentFileTile` below so the stacking order is
 * testable by passing `preview` directly, with no `FileReader` effect
 * needed to exercise it.
 *
 * Both children get an explicit, differing `z-index` (`z-0` / `z-10`) rather
 * than relying on source order. Without that: `FileTileBody`'s content is
 * in-flow and non-positioned, while the preview is `absolute` — and CSS
 * paints positioned content after in-flow content regardless of which comes
 * first in the markup, so the preview would land ON TOP of the icon and
 * filename, not behind them. Two siblings with different non-auto z-index
 * values stack by that value alone, independent of DOM order, so stating
 * `z-10` on `FileTileBody`'s wrapper makes "this one wins" a fact of the
 * markup instead of an accident of paint-order rules.
 */
export function FileTileWithPreview({
  filename,
  preview,
}: {
  filename: string;
  preview: string | null;
}) {
  return (
    <>
      {preview && (
        <div className="text-muted-foreground/60 pointer-events-none absolute inset-0 z-0 overflow-hidden p-2 select-none">
          <pre className="m-0 overflow-hidden p-0 font-mono text-[7px] leading-[1.35] whitespace-pre">
            {preview}
          </pre>
        </div>
      )}
      <div className="relative z-10 size-full">
        <FileTileBody filename={filename} />
      </div>
    </>
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

  return <FileTileWithPreview filename={name} preview={textPreview} />;
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
    <ul className="flex flex-wrap gap-2 px-3">
      {files.map((af, i) => {
        const name = attachmentName(af);
        return (
          // `li` stays `display: contents` (no box of its own — matches the
          // pattern `turn/user-message.tsx` uses for its own `<li>`s), so it
          // is transparent to the `ul`'s flex-wrap layout. Its child below is
          // the REAL positioned box: `relative`, but deliberately NOT the
          // `overflow-hidden` tile div itself — the remove button's negative
          // corner offset needs to sit outside the tile's edge, and nesting
          // it inside an `overflow-hidden` ancestor would clip that corner
          // off. This is the same two-box split `attachment-preview.tsx` used
          // (an outer plain `relative` wrapper, an inner `overflow-hidden`
          // thumbnail box) — `relative` on a `contents` element is inert, so
          // that split has to live one level in from the `<li>`, not on it.
          <li key={i} className="contents">
            <div className="group relative">
              <div title={name} className={af.isImage ? TILE_SURFACE : FILE_TILE_SURFACE}>
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
                <Close className="size-3" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
