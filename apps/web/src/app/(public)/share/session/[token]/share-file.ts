/**
 * File helpers for the public session share surface.
 *
 * The page header owns the Download action, but the file renderer still needs
 * the same behaviour internally — binary/unsupported categories render their
 * own inline "Download" button through the `FileSource`. Keeping one
 * implementation here stops the two paths from drifting into different file
 * names or fetch options.
 */

import { readPublicShareFileBlob } from '@kortix/sdk';

/** Last segment of a workspace path — `/workspace/docs/report.md` → `report.md`. */
export function fileNameFromPath(
  path: string | null | undefined,
  fallback = 'Shared file',
): string {
  if (!path) return fallback;
  return path.split('/').filter(Boolean).at(-1) || fallback;
}

/**
 * Fetch the shared file and hand it to the browser as a download.
 *
 * The SDK reader owns the request: anonymous (the share token in the path is
 * the whole authorization) and `no-store` by default, which matches the
 * viewer's fetches — a share can be revoked or the file rewritten at any time,
 * and a cached 200 would hide that.
 *
 * `fileUrl` is the already-absolute URL built from `share.proxy_path`; the SDK
 * passes an absolute value through and uses `backendUrl` only to resolve a
 * root-relative one.
 */
export async function downloadFileFromUrl(
  backendUrl: string,
  fileUrl: string,
  fileName: string,
): Promise<void> {
  const { blob } = await readPublicShareFileBlob(backendUrl, fileUrl);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
