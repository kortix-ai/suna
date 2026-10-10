/**
 * Short-TTL memo of the last project-session-list ETag per (viewer, query).
 *
 * Why: the session list is the dashboard's poll. The sidebar re-fetches it six
 * times per session open and every few seconds while sessions run; prod bursts
 * of 20-33 requests/minute from a single account were measured on 2026-10-09
 * (KRTX-468), with ~23 of 23 requests slow at the peak. Each poll re-ran the
 * full multi-op inventory (db n=6 warm, n=14 cold) only to discover the page
 * was unchanged and answer 304 — and those operations queue behind each other
 * in the API task's small connection pool, so the burst inflates its own per-op
 * latency ~20-50x (p95 1.7-2.4 s while single-op routes stayed at ~25 ms p50).
 *
 * The weak ETag already promises the response is revalidated per poll; this
 * memo completes that design server-side. A poll whose If-None-Match still
 * matches the ETag computed for the SAME (viewer, query) within the window is
 * answered with a 304 before any database work. Staleness is bounded by the
 * TTL and strictly tighter than what a client already tolerates between two
 * 5 s polls: a 304 only ever tells a client "the bytes you already hold are
 * still current", so a change landing inside the window is picked up by the
 * next poll, never lost.
 *
 * Only the tiny identity of the page is stored — the ETag hash and the
 * continuation cursor — never response bodies, so memory is bytes per key and
 * the cap bounds the worst case. Entries are written only after a successful
 * computation, so errors are never cached.
 */

const TTL_MS = 2_000;
const MAX_ENTRIES = 128;

interface PollEntry {
  etag: string;
  /** The page's continuation token, replayed on the memoized 304. */
  nextCursor: string | null;
  storedAt: number;
}

// replica-local: each API replica memoizes only the polls it served itself; a
// replica without the entry simply computes the page as it always did, and the
// 2 s window keeps any replica's answer within the staleness the poll cadence
// already tolerates. Nothing here needs cross-replica agreement.
const entries = new Map<string, PollEntry>();

/**
 * The memoized 304 for this exact poll: a fresh entry whose ETag matches what
 * the client already holds. Null means "compute normally" — no entry, an
 * expired one, or an ETag that differs from the client's copy.
 */
export function peekSessionListPollEtag(
  key: string,
  ifNoneMatch: string,
): PollEntry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= TTL_MS) {
    entries.delete(key);
    return null;
  }
  return entry.etag === ifNoneMatch ? entry : null;
}

/** Record the page identity after a successful computation. */
export function storeSessionListPollEtag(
  key: string,
  entry: { etag: string; nextCursor: string | null },
): void {
  // Bounded memory: evict oldest-inserted keys past the cap (Map preserves
  // insertion order, so the first keys are the oldest).
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { ...entry, storedAt: Date.now() });
}
