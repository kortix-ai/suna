'use client';

/**
 * The composer's attachment preview — the SAME `AttachmentTile` the sent
 * message uses (`../attachment-tile`), plus the one thing a not-yet-sent file
 * needs that a sent one never does: a corner remove button.
 *
 * Replaces `attachment-preview.tsx`'s 120px name-bar card, which looked
 * nothing like how the same file rendered a moment later once the message
 * sent. That file is not deleted yet: `session-chat-input.tsx` still renders
 * it, and swapping the call site is Task 13's job once every consumer of the
 * old shape moves in one change.
 */

import { useEffect, useState } from 'react';

import { convertHeicBlobToJpeg, isHeicFile } from '@/lib/utils/heic-convert';

import { AttachmentRemoveButton, AttachmentTile, isPreviewableImage } from '../attachment-tile';
import type { AttachedFile } from './types';

/** The two shapes of `AttachedFile` disagree on where the name lives. */
function attachmentName(af: AttachedFile): string {
  return af.kind === 'local' ? af.file.name : af.filename;
}
function attachmentMime(af: AttachedFile): string {
  return af.kind === 'local' ? af.file.type : af.mime;
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
  // WHICH file failed, not merely "something failed". Storing the attachment
  // itself makes the reset free: a new `af` no longer matches, so the flag
  // clears by comparison instead of by a `setState` in the effect body (which
  // is a cascading render, and what the React Compiler rule flags).
  //
  // Before this existed, a failed decode was indistinguishable from one still
  // running — `.catch(() => {})` swallowed the rejection and the tile spun
  // forever on a file that was never going to render.
  const [failedFor, setFailedFor] = useState<AttachedFile | null>(null);
  const failed = failedFor === af;

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
      .catch(() => {
        if (!cancelled) setFailedFor(af);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // `af` (not `af.file`) matches the dependency the original
    // `attachment-preview.tsx` HEIC effect tracked.
  }, [af, isHeic]);

  const src = isHeic ? heicUrl : af.kind === 'local' ? af.localUrl : af.url;

  // Fall back to the named tile — the file is still attached and still sends;
  // only the thumbnail is unavailable.
  if (failed) return <AttachmentTile filename={name} mime={attachmentMime(af)} />;
  if (!src) return <AttachmentTile filename={name} mime={attachmentMime(af)} pending />;
  return <AttachmentTile filename={name} mime={attachmentMime(af)} imageSrc={src} />;
}

/** A locally attached non-image file: the named tile. */
function AttachmentFileTile({ af, name }: { af: AttachedFile; name: string }) {
  return <AttachmentTile filename={name} mime={attachmentMime(af)} />;
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
          <li key={af.kind === 'local' ? af.localUrl : af.url} className="contents">
            <div className="group relative">
              {af.isImage && isPreviewableImage(name, attachmentMime(af)) ? (
                <AttachmentImageTile af={af} name={name} />
              ) : (
                <AttachmentFileTile af={af} name={name} />
              )}
              <AttachmentRemoveButton filename={name} onRemove={() => onRemove(i)} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
