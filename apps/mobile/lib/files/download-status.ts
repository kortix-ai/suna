/**
 * The HTTP status of a finished file download (COR-155). `downloadAsync`
 * writes the response body to disk whatever the status, so a 401 or 404 body
 * used to be shared as `name.zip`. The caller checks the status with this,
 * deletes the temp file, and shows the message instead of sharing.
 *
 * Pure: no React, no React Native.
 */

/** `null` for a 2xx status (share the file); else the message to show. */
export function downloadFailureMessage(status: number | null | undefined): string | null {
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return 'The download did not finish. Try again.';
  }
  if (status >= 200 && status < 300) return null;
  if (status === 401) return 'Your session expired. Sign in again, then retry the download.';
  if (status === 403) return "You don't have access to download this.";
  if (status === 404) return 'Not found in this version. Refresh and try again.';
  if (status === 413) return 'Too large to download on this device.';
  if (status === 429) return 'Too many downloads. Wait a moment, then try again.';
  if (status >= 500) return `The server could not prepare the download (HTTP ${status}). Try again.`;
  return `The download failed (HTTP ${status}). Try again.`;
}
