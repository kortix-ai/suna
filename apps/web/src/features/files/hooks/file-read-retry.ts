export const UPLOADED_FILE_READ_RETRY_DELAY_MS = 2_000;
export const UPLOADED_FILE_READ_RETRY_WINDOW_MS = 60_000;
export const UPLOADED_FILE_READ_MAX_RETRIES = Math.ceil(
  UPLOADED_FILE_READ_RETRY_WINDOW_MS / UPLOADED_FILE_READ_RETRY_DELAY_MS,
);

export function isUploadedWorkspacePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/^\/+/, '');
  return normalized === 'workspace/uploads' || normalized.startsWith('workspace/uploads/');
}

export function fileReadRetryDelayMs(
  attempt: number,
  filePath?: string | null,
): number {
  if (isUploadedWorkspacePath(filePath)) return UPLOADED_FILE_READ_RETRY_DELAY_MS;
  return Math.min(1000 * Math.pow(2, attempt), 5000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
}

function isPermanentFileReadFailure(error: unknown): boolean {
  // Prefer a numeric HTTP status when the thrown error carries one: any 4xx
  // except 408/429 is a client error that won't fix itself on retry.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true;
  }
  const msg = errorMessage(error);
  return (
    msg.includes('404') ||
    msg.includes('403') ||
    msg.includes('400') ||
    msg.includes('bad request') ||
    // A directory read (e.g. `.opencode`) returns 400 "Path is a directory" —
    // permanent, must not be retried on a loop.
    msg.includes('is a directory') ||
    msg.includes('eisdir') ||
    msg.includes('not found') ||
    msg.includes('access denied') ||
    msg.includes('no such file') ||
    msg.includes('enoent') ||
    msg.includes('does not exist') ||
    msg.includes('path not found')
  );
}

export function shouldRetryFileRead(
  filePath: string | null | undefined,
  failureCount: number,
  error: unknown,
): boolean {
  if (isUploadedWorkspacePath(filePath)) {
    return failureCount < UPLOADED_FILE_READ_MAX_RETRIES;
  }

  if (isPermanentFileReadFailure(error)) return false;
  return failureCount < 3;
}
