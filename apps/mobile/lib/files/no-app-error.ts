/**
 * Whether opening a file failed because no app on the device handles its type.
 * Android's view intent throws `ActivityNotFoundException` ("No Activity found
 * to handle Intent …"); iOS Quick Look rejects `UNABLE_TO_OPEN_FILE_TYPE`. Pure.
 */
export function isNoAppError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === 'UNABLE_TO_OPEN_FILE_TYPE') return true;
  return /no activity found/i.test(error.message);
}
