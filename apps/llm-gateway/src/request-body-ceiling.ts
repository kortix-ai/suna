/**
 * Bun.serve refuses any request whose body exceeds `maxRequestBodySize` with
 * its own plain-text 413 BEFORE `fetch()` runs: no gateway log line, no typed
 * `request_too_large` envelope, and on the first attempt just a socket close
 * mid-upload (the client sees "Cannot connect to API"). Bun's default is
 * 128 MiB — the same number as DEFAULT_MAX_REQUEST_BYTES — so the pipeline's
 * own 413 (logged with the exact byte counts, digit-free body) could never
 * fire for a 129 MiB body; Bun's did. Essentia 2026-08-25: three image-heavy
 * turns died that way with nothing in the gateway log to explain them.
 *
 * Keep Bun's ceiling strictly ABOVE the per-request cap so the pipeline is the
 * layer that decides and records. The extra headroom is never buffered:
 * readBoundedBody stops reading one byte past the cap.
 */
export const BUN_DEFAULT_MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

// A disabled per-request cap (0) still needs a finite Bun ceiling; the
// in-flight budget refuses what the process cannot hold long before this.
const UNCAPPED_BUN_CEILING_BYTES = 4 * 1024 * 1024 * 1024;

export function bunRequestBodyCeilingBytes(perRequestCapBytes: number): number {
  if (!Number.isFinite(perRequestCapBytes) || perRequestCapBytes <= 0) {
    return UNCAPPED_BUN_CEILING_BYTES;
  }
  return Math.max(perRequestCapBytes * 2, BUN_DEFAULT_MAX_REQUEST_BODY_BYTES + 1);
}
