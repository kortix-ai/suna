/**
 * Upload-batch rules for the Drive explorer.
 *
 * Framework-free on purpose: `drive-explorer.tsx` cannot be rendered in this
 * app's test runner (no jsdom/happy-dom, no `@testing-library/react` — see
 * `members-tab.test.tsx`), so every rule that used to be inlined in the
 * component lives here and is unit-tested directly in `upload-batch.test.ts`.
 *
 * The size guard reuses `@kortix/shared`'s `UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES`
 * (50 MB) rather than inventing a second number. It deliberately does NOT use
 * that module's `isAllowedFile`, because that helper also enforces an
 * extension allowlist — which would reject the extension-less files a coding
 * workspace is full of (`Dockerfile`, `Makefile`, `LICENSE`).
 */

import { UPLOAD_LIMITS, formatFileSize } from '@kortix/shared/constants';

/** Largest file the client will hand to the upload mutation. */
export const MAX_UPLOAD_BYTES = UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES;

/** Human-facing form of {@link MAX_UPLOAD_BYTES}, used in every rejection. */
export const MAX_UPLOAD_LABEL = `${UPLOAD_LIMITS.MAX_FILE_SIZE_MB} MB`;

/** The subset of `File` these rules need — keeps the module DOM-free. */
export interface UploadCandidate {
  readonly name: string;
  readonly size: number;
}

export interface RejectedUpload<T extends UploadCandidate> {
  readonly file: T;
  /** Ready-to-toast sentence: names the file, its size, and the limit. */
  readonly reason: string;
}

export interface UploadBatchPartition<T extends UploadCandidate> {
  readonly accepted: T[];
  readonly rejected: RejectedUpload<T>[];
}

/**
 * Why this file cannot be uploaded, or `null` if it can.
 *
 * Checked before any bytes move. Without it the first thing that stops a user
 * is Bun's 128 MiB body cap, which answers `413` with an EMPTY body — the SDK
 * can only surface "Upload failed (413): Request Entity Too Large", naming
 * neither the file nor a limit.
 */
export function uploadRejectionReason(file: UploadCandidate): string | null {
  if (file.size <= MAX_UPLOAD_BYTES) return null;
  return `${file.name} is ${formatFileSize(file.size)} — the upload limit is ${MAX_UPLOAD_LABEL}`;
}

/** Split a batch into what will be sent and what is refused up front. */
export function partitionUploadBatch<T extends UploadCandidate>(
  files: readonly T[],
): UploadBatchPartition<T> {
  const accepted: T[] = [];
  const rejected: RejectedUpload<T>[] = [];
  for (const file of files) {
    const reason = uploadRejectionReason(file);
    if (reason) rejected.push({ file, reason });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** Files sent at once. Enough to fill the pipe, few enough not to starve the listing. */
export const UPLOAD_CONCURRENCY = 4;

/**
 * Run `fn` over `items`, at most `limit` at a time, in order of start. A
 * failure in one call is the caller's to catch: the pool never aborts.
 */
export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(lanes);
}

/**
 * Directory an upload lands in.
 *
 * `dropTargetDir` is the folder a file was dropped ONTO. It wins over the
 * folder being viewed: without it, dropping onto a visible folder row silently
 * uploaded into the current directory instead.
 *
 * `undefined` means "the source's default root" — the upload mutation's
 * `targetPath` is optional and root uploads must not send a path.
 */
export function resolveUploadTarget(input: {
  currentPath: string;
  isRootPath: boolean;
  dropTargetDir?: string;
}): string | undefined {
  const dropped = input.dropTargetDir?.trim();
  if (dropped) return dropped;
  return input.isRootPath ? undefined : input.currentPath;
}

/** What a drag hovering a row means. `null` = the row must ignore it. */
export type RowDragIntent = 'move' | 'upload' | null;

/**
 * Classify a row drag from `DataTransfer.types`.
 *
 * An internal move carries the explorer's own MIME type; an external file drag
 * carries `Files`. Rows used to test only the former, so an external drop on a
 * folder fell through to the page handler and landed in the wrong directory.
 */
export function rowDragIntent(
  types: readonly string[],
  options: {
    isDirectory: boolean;
    canMove: boolean;
    canUpload: boolean;
    /** The explorer's internal drag MIME (`DRAG_MIME`). */
    moveMime: string;
  },
): RowDragIntent {
  if (!options.isDirectory) return null;
  if (types.includes(options.moveMime)) return options.canMove ? 'move' : null;
  if (types.includes('Files')) return options.canUpload ? 'upload' : null;
  return null;
}
