/**
 * File helpers for the public session share surface.
 *
 * The page header owns the Download action, but the file renderer still needs
 * the same behaviour internally — binary/unsupported categories render their
 * own inline "Download" button through the `FileSource`. Keeping one
 * implementation here stops the two paths from drifting into different file
 * names or fetch options.
 */

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
 * `cache: 'no-store'` matches the viewer's fetches: a share can be revoked or
 * the file rewritten at any time, and a cached 200 would hide that.
 */
export async function downloadFileFromUrl(fileUrl: string, fileName: string): Promise<void> {
  const res = await fetch(fileUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.statusText || `HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
