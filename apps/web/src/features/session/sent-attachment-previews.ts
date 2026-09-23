// Identity: a sent attachment is keyed by its SDK upload id (`AttachedFile.uploadId`). The SDK
// mints each id once per tab, across every composer's controller, so a Send from project home and
// a Send from the session composer never share a key. Refs (`<file attachment="…">`), tiles and
// submitted lists carry that id from Send to delivery.
// The composer hands its object URLs over at Send. This per-tab cache revokes each one after the
// delivered source decodes, or when the last mounted session unmounts.
import { isHeicFile } from '@/lib/utils/heic-convert';

import type { AttachedFile } from './composer/types';

/** One file a Send carried: its identity (absent for a remote file), name and type. */
export interface SentAttachment {
  id?: string;
  filename: string;
  mime: string;
}

const previews = new Map<string, string>();
const convertedPreviews = new Map<string, string>();
/** Per session: the identities its first prompt was sent with. */
const firstPromptSent = new Map<string, ReadonlyArray<SentAttachment>>();
let holders = 0;

/** The picture the composer showed for this attachment, while a sent tile still needs it. */
export function sentAttachmentPreview(id: string | undefined): string | undefined {
  return id ? previews.get(id) : undefined;
}

/**
 * Remember the identities a session's first prompt was sent with.
 *
 * The first-prompt store drops its copy the frame the transcript carries the files. Those
 * delivered parts cannot draw a picture until the sandbox copy loads (~24 s, browser timeline
 * 2026-09-15), so the first turn and the boot shell read the identities from here instead.
 */
export function rememberFirstPromptAttachments(
  sessionId: string,
  attachments: ReadonlyArray<SentAttachment>,
): void {
  if (!attachments.some((attachment) => attachment.id)) return;
  firstPromptSent.set(sessionId, attachments);
}

/** The identities `rememberFirstPromptAttachments` kept for this session. */
export function firstPromptAttachments(
  sessionId: string | undefined,
): ReadonlyArray<SentAttachment> | undefined {
  return sessionId ? firstPromptSent.get(sessionId) : undefined;
}

/**
 * The composer tile converted a HEIC upload to JPEG. A Send takes that JPEG.
 * The returned function runs when the tile lets go: it revokes the JPEG unless a Send took it.
 */
export function holdConvertedPreview(id: string, url: string): () => void {
  convertedPreviews.set(id, url);
  return () => {
    if (convertedPreviews.get(id) === url) convertedPreviews.delete(id);
    revokeUnsentPreview(url);
  };
}

/** At Send: retain file bytes for previews and downloads. HEIC hands over its JPEG, or nothing. */
export function adoptSentAttachmentPreviews(files: readonly AttachedFile[]): void {
  for (const file of files) {
    if (file.kind !== 'local' || !file.uploadId) continue;
    const url =
      convertedPreviews.get(file.uploadId) ??
      (isHeicFile(file.file.name) ? undefined : file.localUrl);
    if (url) previews.set(file.uploadId, url);
  }
}

/**
 * A refused send: its files are back in the composer tray, which draws their object URLs again.
 * The cache lets go of them without revoking. A HEIC send's JPEG is revoked unless a tile still
 * holds it: a tile that unmounted at Send converts again when it remounts.
 */
export function disownSentAttachmentPreviews(files: readonly AttachedFile[]): void {
  for (const file of files) {
    if (file.kind !== 'local' || !file.uploadId) continue;
    const url = previews.get(file.uploadId);
    if (!url) continue;
    previews.delete(file.uploadId);
    if (url !== file.localUrl && convertedPreviews.get(file.uploadId) !== url)
      revokeUnsentPreview(url);
  }
}

/** The composer revokes its object URLs through this. A URL a Send took stays alive. */
export function revokeUnsentPreview(url: string): void {
  for (const owned of previews.values()) if (owned === url) return;
  URL.revokeObjectURL(url);
}

/** The delivered source decoded on screen, so the composer's picture is no longer needed. */
export function releaseSentAttachmentPreview(id: string): void {
  const url = previews.get(id);
  if (!url) return;
  previews.delete(id);
  URL.revokeObjectURL(url);
}

/**
 * A mounted session holds the cache. When the last holder unmounts, every preview is revoked.
 * The check waits one microtask, so a StrictMode unmount-and-remount keeps the previews.
 */
export function retainSentAttachmentPreviews(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    queueMicrotask(() => {
      if (holders > 0) return;
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
      firstPromptSent.clear();
    });
  };
}

/**
 * The list a turn's strip draws until each delivered part renders (`mergeSentAttachments`), so
 * the strip never shrinks while the echo streams.
 *
 * Order: the list this tab's send remembered under the id its bubble was painted with (`originId`
 * when the server re-minted the echo); then, for the first turn only, the first-prompt handover,
 * and after it stops, the first prompt's remembered identities (`firstTurnSent`); then the names
 * on the turn's queued inbox row, for a turn this tab did not send (a reload or another tab).
 */
export function sentAttachmentsForTurn(input: {
  sentByMessage: Readonly<Record<string, ReadonlyArray<SentAttachment>>>;
  messageId: string;
  originId?: string;
  isFirstTurn: boolean;
  firstTurnHandover?: ReadonlyArray<SentAttachment>;
  firstTurnSent?: ReadonlyArray<SentAttachment>;
  queuedRowAttachments?: ReadonlyArray<SentAttachment>;
}): ReadonlyArray<SentAttachment> | undefined {
  const own = input.sentByMessage[input.originId ?? input.messageId];
  if (own) return own;
  if (input.isFirstTurn && input.firstTurnHandover?.length) return input.firstTurnHandover;
  if (input.isFirstTurn && input.firstTurnSent?.length) return input.firstTurnSent;
  return input.queuedRowAttachments?.length ? input.queuedRowAttachments : undefined;
}
