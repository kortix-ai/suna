import { createHash } from 'node:crypto';

// Prompt delivery is the one MUTATING call on the sandbox proxy: POSTing the
// same body twice to opencode enqueues the user's message twice (the 3x-queued
// bug). opencode has no idempotency of its own, so the proxy must never re-send
// a prompt body it may already have delivered. This tiny in-memory cache records
// each prompt delivery by its Idempotency-Key (or a content-hash fallback) so a
// duplicate inbound request — a client resend, or the other proxy edge — carrying
// the same key SHORT-CIRCUITS instead of re-POSTing. It is intentionally best-
// effort (a hot-path Map, no DB write per request) and strictly bounded by both a
// TTL and a max entry count so it can never grow without bound.

const DEDUPE_TTL_MS = 60_000;
const MAX_ENTRIES = 2_000;

const seen = new Map<string, number>(); // key -> expiresAt (ms epoch)

// Map preserves insertion order, so the oldest entries live at the front: trim
// expired ones from the front, then cap total size by dropping the oldest.
function evict(now: number): void {
  for (const [key, expiresAt] of seen) {
    if (expiresAt > now) break;
    seen.delete(key);
  }
  while (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

// Stable per-prompt key: the caller's Idempotency-Key when present (the CLI mints
// one UUID per logical prompt), else a content hash so retries of the SAME body
// still collide even from a client that sends no header.
export function promptDeliveryKey(opts: {
  idempotencyKey: string | null;
  sandboxId: string;
  sessionId: string;
  body: ArrayBuffer | undefined;
}): string {
  const provided = opts.idempotencyKey?.trim();
  if (provided) return `idem:${provided}`;
  const hash = createHash('sha256')
    .update(opts.sandboxId)
    .update('\0')
    .update(opts.sessionId)
    .update('\0')
    .update(opts.body ? new Uint8Array(opts.body) : new Uint8Array())
    .digest('hex');
  return `hash:${hash}`;
}

// Claim a prompt delivery. Returns true the first time a key is seen within the
// TTL (the caller should deliver), false on a repeat (the caller should short-
// circuit without re-POSTing). The claim is taken up-front — modelling the
// delivery as "in-flight" — so a concurrent duplicate is deduped even before the
// first attempt returns.
export function claimPromptDelivery(key: string, now: number = Date.now()): boolean {
  evict(now);
  const expiresAt = seen.get(key);
  if (expiresAt !== undefined && expiresAt > now) return false;
  seen.set(key, now + DEDUPE_TTL_MS);
  return true;
}

// Release a claim taken by claimPromptDelivery. Call this ONLY when the prompt
// turned out never to reach the sandbox — every forward attempt failed before the
// POST left the proxy (e.g. env sync) or PROVED nothing was accepted (the upstream
// refused the connection). Dropping the claim lets a client retry under the same
// key re-attempt delivery instead of short-circuiting to a phantom "duplicate"
// no-op (silent message loss). Never release on an AMBIGUOUS failure — a fetch
// that timed out or reset mid-flight — since opencode may already have enqueued
// the message and re-POSTing it would double-enqueue (the very bug the claim
// prevents). No-op when the key was already evicted.
export function releasePromptDelivery(key: string): void {
  seen.delete(key);
}

// Test-only: drop all cached claims so cases don't leak into one another.
export function __resetPromptDedupe(): void {
  seen.clear();
}
