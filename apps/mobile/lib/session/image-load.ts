/**
 * Size gate for sandbox image previews in the session thread.
 *
 * The thread probes `content-length` with a HEAD request before the native
 * image loader downloads a file. Files above the limit wait for a tap.
 */

export const IMAGE_AUTO_LOAD_LIMIT_BYTES = 8 * 1024 * 1024;

export function decideImageLoad({
  contentLength,
  limitBytes,
}: {
  contentLength: number | null;
  limitBytes: number;
}): 'load' | 'tap-to-load' {
  if (contentLength === null) return 'load';
  return contentLength > limitBytes ? 'tap-to-load' : 'load';
}

/** Parses a `content-length` header value. Returns null when absent or invalid. */
export function parseContentLength(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** "8.5 MB" below 10 MB, "25 MB" from 10 MB up. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export interface ProbeCache {
  has(url: string): boolean;
  get(url: string): number | null | undefined;
  set(url: string, contentLength: number | null): void;
  size(): number;
}

/**
 * Bounded least-recently-used cache of HEAD probe results keyed by raw file
 * URL, so a list cell that remounts does not probe the same file again.
 */
export function createProbeCache(limit: number): ProbeCache {
  const entries = new Map<string, number | null>();
  return {
    has: (url) => entries.has(url),
    get(url) {
      if (!entries.has(url)) return undefined;
      const value = entries.get(url) as number | null;
      entries.delete(url);
      entries.set(url, value);
      return value;
    },
    set(url, contentLength) {
      entries.delete(url);
      entries.set(url, contentLength);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}
