/**
 * composer-uploads — pure state for the composer's attachment tiles: the
 * progress ring shown per file (from a `PromptAttachmentItem`) and the
 * message shown when an upload fails. `useComposerAttachments.ts` is the
 * React glue; `ComposerAttachmentTiles` (`components/session/
 * composer-attachment-tiles.tsx`) is the render. Kept import-free of React
 * Native so it tests with plain `bun test`.
 */
import type { ComposerAttachmentUpload } from '@/components/session/composer-attachment-tiles';
import type { AttachedFile } from '@/lib/session/attachments';
import type { PromptAttachmentItem, PromptAttachmentSnapshot } from '@kortix/sdk';

/** How long `takeForSend` waits for every staged upload to finish. */
export const SEND_UPLOAD_WAIT_MS = 120_000;

/**
 * The tile's corner state for one file, from its `PromptAttachmentItem`
 * (`undefined` while the file is still being read off the device, before the
 * controller has an entry for it).
 */
export function composerUploadState(
  item: Pick<PromptAttachmentItem, 'status' | 'receivedBytes' | 'size'> | undefined,
): ComposerAttachmentUpload | undefined {
  if (!item) return { progress: 0 };
  switch (item.status) {
    case 'pending':
    case 'uploading':
      return { progress: Math.min(99, Math.floor((item.receivedBytes / item.size) * 100)) };
    case 'processing':
      return { progress: 99 };
    case 'ready':
      return undefined;
    case 'error':
    case 'aborted':
      return { failed: true };
    default:
      return undefined;
  }
}

/** What the tiles need to reach a live upload: the controller's subscription and Retry. */
export interface ComposerUploadSources {
  subscribe: (listener: () => void) => () => void;
  retry: (id: string) => void;
}

/**
 * The composer's upload entries, keyed by the file's index in `files`
 * (`ComposerAttachmentTiles`' shape): a failed upload carries `onRetry`, a
 * running one a `live` progress source, a finished one nothing, and a file
 * still being read off the device a plain 0%.
 *
 * `snapshot` is read lazily — once per file lookup and again on each
 * `live.getProgress` — so a progress tick reaches only the tile that draws it,
 * never the composer. Pure; the React glue (`useComposerAttachments`) re-runs
 * it when the file list or a phase changes.
 */
export function buildComposerUploads(
  files: ReadonlyArray<AttachedFile>,
  snapshot: () => PromptAttachmentSnapshot,
  { subscribe, retry }: ComposerUploadSources,
): Record<number, ComposerAttachmentUpload> {
  const result: Record<number, ComposerAttachmentUpload> = {};
  files.forEach((file, index) => {
    const id = file.uploadId;
    const item = id ? snapshot().attachments.find((entry) => entry.id === id) : undefined;
    const state = composerUploadState(item);
    if (!state) return;
    if (state.failed) {
      result[index] = { ...state, onRetry: () => id && retry(id) };
    } else if (id) {
      result[index] = {
        ...state,
        live: {
          subscribe,
          getProgress: () =>
            composerUploadState(snapshot().attachments.find((entry) => entry.id === id))?.progress,
        },
      };
    } else {
      result[index] = state;
    }
  });
  return result;
}

/** A send tapped while a picked file is still being read off the device. */
export const STILL_READING_MESSAGE = 'Still reading a file. Try again in a moment.';

/** The error `takeForSend` throws for that case; `uploadErrorMessage` keeps its words. */
export function stillReadingError(): Error {
  return Object.assign(new Error(STILL_READING_MESSAGE), { code: 'still_reading' as const });
}

/** Words an upload failure for the tile's failure scrim / a toast. */
export function uploadErrorMessage(err: unknown, filename?: string): string {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined;
  if (code === 'still_reading') return STILL_READING_MESSAGE;
  if (code === 'attachment_expired') return 'Attachment expired. Attach the file again.';
  const isAbort =
    code === 'TIMEOUT' || (err instanceof Error && err.name === 'AbortError');
  if (isAbort) return 'The upload is taking too long. Try again.';
  return `Couldn't attach ${filename ?? 'the file'}. Try again.`;
}
