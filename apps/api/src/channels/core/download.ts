/**
 * The largest file the Slack and Teams download proxies return. The proxy
 * holds the whole body in memory, and a Slack or Teams file can be 1 GB.
 */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export const DOWNLOAD_TOO_LARGE = `file is larger than ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB, the download limit`;

/** The response body, or null when it is larger than `max`. Stops reading at the limit. */
export async function readCapped(res: Response, max = MAX_DOWNLOAD_BYTES): Promise<Uint8Array | null> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    // Leaving the loop cancels the stream: the rest is never downloaded.
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
