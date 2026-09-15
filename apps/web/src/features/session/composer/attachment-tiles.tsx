'use client';

/**
 * The composer's attachment preview — the SAME `AttachmentTile` the sent
 * message uses (`../attachment-tile`), plus what a not-yet-sent file needs
 * that a sent one never does: a corner remove button and its upload state.
 *
 * Upload state stays inside the tile box: a progress ring in the corner, or a
 * scrim with the failure reason on failure. There is no text row, so the
 * composer height never changes while a file uploads.
 *
 * Replaces `attachment-preview.tsx`'s 120px name-bar card, which looked
 * nothing like how the same file rendered a moment later once the message
 * sent. That file is not deleted yet: `session-chat-input.tsx` still renders
 * it, and swapping the call site is Task 13's job once every consumer of the
 * old shape moves in one change.
 */

import type { PromptAttachmentItem } from '@kortix/sdk';
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { IconRefresh } from '@/components/ui/kortix-icons';
import { ProgressRing } from '@/components/ui/progress-ring';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { convertHeicBlobToJpeg, isHeicFile } from '@/lib/utils/heic-convert';
import { holdConvertedPreview } from '../sent-attachment-previews';

import { AttachmentRemoveButton, AttachmentTile, isPreviewableImage } from '../attachment-tile';
import {
  attachmentFailureReason,
  attachmentFailureRetryable,
  type AttachmentFailureReason,
} from './attachment-submission';
import type { AttachedFile } from './types';

type AttachmentTileCopyKey =
  | 'uploadFailed'
  | 'retryNamed'
  | 'didNotUpload'
  | 'billingRequired'
  | 'budgetExceeded'
  | 'tooLarge'
  | 'expired';

type AttachmentTileTranslator = (key: AttachmentTileCopyKey, values?: { name?: string }) => string;

const REASON_COPY: Record<AttachmentFailureReason, AttachmentTileCopyKey> = {
  billing: 'billingRequired',
  budget: 'budgetExceeded',
  tooLarge: 'tooLarge',
  expired: 'expired',
  connection: 'uploadFailed',
};

/** Resolve the failure reasons, the Retry label, and the failure announcement from the active locale. */
export function attachmentTileCopy(t: AttachmentTileTranslator) {
  return {
    uploadFailed: t('uploadFailed'),
    failureReason: (reason: AttachmentFailureReason) => t(REASON_COPY[reason]),
    retryNamed: (name: string) => t('retryNamed', { name }),
    didNotUpload: (name: string) => t('didNotUpload', { name }),
  };
}

/** The two shapes of `AttachedFile` disagree on where the name lives. */
function attachmentName(af: AttachedFile): string {
  return af.kind === 'local' ? af.file.name : af.filename;
}
function attachmentMime(af: AttachedFile): string {
  return af.kind === 'local' ? af.file.type : af.mime;
}

/** The ring waits this long after attach, so a small file never flashes upload chrome. */
const RING_DELAY_MS = 400;

export interface DueTimers {
  now(): number;
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: DueTimers = {
  now: () => Date.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A `useSyncExternalStore` subscription that notifies once `due` has passed.
 * A timer can fire a little before `due` against `Date.now()`; it then re-arms
 * for the remainder, so the render at `due` is never skipped.
 */
export function subscribeWhenDue(due: number, timers: DueTimers = browserTimers) {
  return (notify: () => void): (() => void) => {
    let handle: unknown;
    const check = () => {
      const remaining = due - timers.now();
      if (remaining > 0) handle = timers.set(check, remaining);
      else notify();
    };
    handle = timers.set(check, Math.max(0, due - timers.now()));
    return () => timers.clear(handle);
  };
}

/**
 * Whether `due` has passed. Time is an external source, so it is read through
 * `useSyncExternalStore`. While `waiting`, one timer re-renders at `due`.
 */
function useTimePassed(due: number, waiting: boolean): boolean {
  const subscribe = useCallback(
    (notify: () => void) => (waiting ? subscribeWhenDue(due)(notify) : () => {}),
    [due, waiting],
  );
  const passed = () => Date.now() >= due;
  return useSyncExternalStore(subscribe, passed, passed);
}

/**
 * The upload's corner mark: a determinate ring, shown only when the upload
 * still runs 400 ms after attach. On ready it fades out in place.
 */
function UploadRing({
  upload,
  attachedAt,
  name,
}: {
  upload: PromptAttachmentItem;
  attachedAt: number;
  name: string;
}) {
  const running =
    upload.status === 'pending' || upload.status === 'uploading' || upload.status === 'processing';
  const shown = useTimePassed(attachedAt + RING_DELAY_MS, running);
  if (!shown) return null;
  const percent =
    upload.status === 'pending'
      ? 0
      : upload.status === 'uploading'
        ? Math.min(100, Math.floor((upload.receivedBytes / upload.size) * 100))
        : 100;
  return (
    <span
      data-slot="upload-ring"
      role={running ? 'progressbar' : undefined}
      aria-label={running ? name : undefined}
      aria-valuemin={running ? 0 : undefined}
      aria-valuemax={running ? 100 : undefined}
      aria-valuenow={running ? percent : undefined}
      aria-hidden={running ? undefined : true}
      className={cn(
        'flex transition-opacity duration-(--duration-moderate) ease-out',
        running ? 'opacity-100' : 'opacity-0',
      )}
    >
      <ProgressRing value={percent} />
    </span>
  );
}

/**
 * A locally attached image.
 *
 * HEIC is decoded to JPEG first — browsers cannot render HEIC natively —
 * carried over verbatim from the old `attachment-preview.tsx`. The decode is
 * async, so until it resolves the tile falls back to the named treatment,
 * matching how the sent message's own `AttachmentImage` handles a src that
 * has not resolved yet (`turn/user-message.tsx`).
 */
function AttachmentImageTile({
  af,
  name,
  corner,
  overlay,
}: {
  af: AttachedFile;
  name: string;
  corner?: ReactNode;
  overlay?: ReactNode;
}) {
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
    let letGo: (() => void) | null = null;
    convertHeicBlobToJpeg(af.file)
      .then((jpeg) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(jpeg);
        // A Send takes this JPEG as the sent message's picture.
        letGo = af.uploadId
          ? holdConvertedPreview(af.uploadId, objectUrl)
          : () => URL.revokeObjectURL(objectUrl);
        setHeicUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailedFor(af);
      });
    return () => {
      cancelled = true;
      letGo?.();
    };
    // `af` (not `af.file`) matches the dependency the original
    // `attachment-preview.tsx` HEIC effect tracked.
  }, [af, isHeic]);

  const src = isHeic ? heicUrl : af.kind === 'local' ? af.localUrl : af.url;

  // Fall back to the named tile — the file is still attached and still sends;
  // only the thumbnail is unavailable.
  if (failed || !src)
    return (
      <AttachmentTile filename={name} mime={attachmentMime(af)} corner={corner} overlay={overlay} />
    );
  return (
    <AttachmentTile
      filename={name}
      mime={attachmentMime(af)}
      imageSrc={src}
      corner={corner}
      overlay={overlay}
    />
  );
}

export function AttachmentTiles({
  files,
  uploads = [],
  onRemove,
  onRetry,
}: {
  files: AttachedFile[];
  uploads?: readonly PromptAttachmentItem[];
  onRemove: (index: number) => void;
  onRetry?: (id: string) => void;
}) {
  const t = useTranslations('hardcodedUi.composerAttachments');
  const copy = attachmentTileCopy(t);
  if (files.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2 px-3">
      {files.map((af, i) => {
        const name = attachmentName(af);
        const uploadId = af.kind === 'remote' ? undefined : af.uploadId;
        const upload = uploadId ? uploads.find((item) => item.id === uploadId) : undefined;
        // `submit` unlists an id: a send holds it now, so this tray cannot remove it.
        const held = uploadId !== undefined && !upload;
        const failed = upload?.status === 'error' || upload?.status === 'aborted';
        const running =
          upload?.status === 'pending' ||
          upload?.status === 'uploading' ||
          upload?.status === 'processing';
        const corner =
          upload && !failed ? (
            <UploadRing
              upload={upload}
              attachedAt={af.kind === 'local' ? (af.attachedAt ?? 0) : 0}
              name={name}
            />
          ) : undefined;
        // A refusal (billing, budget, size, expiry) answers Retry the same way, so it
        // offers only Remove. The reason is a tooltip on the whole tile and a line for
        // screen readers.
        const reason = failed ? attachmentFailureReason(upload?.error) : undefined;
        const overlay =
          upload && reason ? (
            <Hint label={copy.failureReason(reason)} side="top">
              <span className="bg-background/70 absolute inset-0 flex items-center justify-center">
                <span className="sr-only">{copy.failureReason(reason)}</span>
                {onRetry && upload.file && attachmentFailureRetryable(reason) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={copy.retryNamed(name)}
                    onClick={() => onRetry(upload.id)}
                  >
                    <IconRefresh />
                  </Button>
                )}
              </span>
            </Hint>
          ) : undefined;
        const tile =
          af.isImage && isPreviewableImage(name, attachmentMime(af)) ? (
            <AttachmentImageTile af={af} name={name} corner={corner} overlay={overlay} />
          ) : (
            <AttachmentTile
              filename={name}
              mime={attachmentMime(af)}
              corner={corner}
              overlay={overlay}
            />
          );
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
          <li
            key={uploadId ? `attachment:${uploadId}` : af.kind === 'local' ? af.localUrl : af.url}
            className="contents"
          >
            <div className="group relative" aria-busy={running || undefined}>
              {tile}
              {!held && <AttachmentRemoveButton filename={name} onRemove={() => onRemove(i)} />}
              {/* Mounted from attach, so the one change at failure is announced. */}
              <span className="sr-only" aria-live="polite">
                {failed ? copy.didNotUpload(name) : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
