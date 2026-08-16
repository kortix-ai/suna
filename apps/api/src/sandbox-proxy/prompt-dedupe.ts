import { createHash } from 'node:crypto';

// Prompt delivery is the one MUTATING call on the sandbox proxy: POSTing the
// same body twice to opencode enqueues the user's message twice (the 3x-queued
// bug). opencode has no idempotency of its own, so the proxy must never re-send
// a prompt body it may already have delivered. This tiny in-memory cache records
// each prompt delivery by its Idempotency-Key, its wire messageID, or a
// content-hash fallback (see `promptDeliveryKey`'s precedence) so a duplicate
// inbound request — a client resend, a queued-command retry after a wake, or
// the other proxy edge — carrying the same key SHORT-CIRCUITS instead of
// re-POSTing. It is intentionally best-effort (a hot-path Map, no DB write per
// request) and strictly bounded by both a TTL and a max entry count so it can
// never grow without bound.

/**
 * Which upstream calls are non-idempotent agent turns — the ones the proxy may
 * never re-POST, and the ones that must take a dedupe claim.
 *
 * THREE endpoints, not two. `/command` was missing, and that omission is the
 * whole of the duplicate-send bug observed on 2026-08-11 (session 9f6b0d87):
 * one `/webapp` submit produced four identical user messages, 11.0s / 11.8s /
 * 13.7s apart. A `/` slash-command posts to `POST /session/:id/command`, which
 * creates a user message and runs a turn exactly like `/message` does — but it
 * matched none of the guards, so it got treated as an ordinary idempotent
 * request: no dedupe claim, retried on 5xx, retried on an ambiguous
 * timeout/abort, four attempts, four executions.
 *
 * Keep this as the ONE list. The predicate it replaced was
 * `shouldSyncProjectEnvBeforeProxy`, whose name is about env sync and whose
 * path list happened to double as "is this non-idempotent" — so adding an
 * endpoint to one concern silently meant opting into the other, and forgetting
 * to meant opting out of every safety guard at once. Env sync keeps its own
 * predicate in `routes/preview.ts`; this one answers only "may the proxy send
 * this body twice?".
 */
export function isNonIdempotentSessionWrite(
  port: number,
  method: string,
  path: string,
): boolean {
  if (port !== 8000) return false;
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/session\/[^/]+\/(?:prompt_async|message|command)(?:$|[/?#])/.test(path);
}

/**
 * Should this delivery take a dedupe CLAIM, as opposed to merely being
 * protected from retries?
 *
 * Two different questions, and conflating them costs a message either way.
 * `isNonIdempotentSessionWrite` answers "may the proxy re-send this?" — it must
 * be true for all three endpoints, and that is what stopped the 4x duplicate.
 * This answers "may the proxy short-circuit a LATER request that looks the
 * same?", which is a much stronger claim, and it is only safe when the key
 * genuinely identifies one logical submission.
 *
 * A prompt body carries client-generated content that differs between two
 * separate submissions, so its content hash is a sound identity. A COMMAND body
 * is `{command, arguments, agent, model}` and nothing else — running
 * `/webapp build a site` twice on purpose produces byte-identical bodies. With
 * a blanket claim the second is answered `200 {"deduplicated": true}` and
 * silently never runs, which is the worst outcome available: no error, no
 * message, no turn. And it fires in exactly the situation the user is already
 * in — re-sending a command that appeared to fail.
 *
 * So a command claims only when the CALLER supplied an `Idempotency-Key` (the
 * CLI mints one per logical prompt). A deliberate re-run then gets through,
 * while a genuine retry under the same key is still short-circuited. The
 * browser, which sends no key, relies on the retry guards instead — and now
 * that `/command` is retried by nobody (proxy, TanStack, and the in-flight ref
 * all refuse), there is no duplicate left for the claim to catch.
 */
export function shouldClaimPromptDelivery(path: string, hasIdempotencyKey: boolean): boolean {
  const isCommand = /^\/session\/[^/]+\/command(?:$|[/?#])/.test(path);
  return isCommand ? hasIdempotencyKey : true;
}

// T13: 10 minutes, not 60s. A wake from auto-stop routinely takes
// longer than 60s on its own (see BOOT_BACKOFF_MS in the SDK's messages.ts,
// which windows a client-side retry out to ~30s before this cache would even
// see the repeat), and the API's own queued `continue_session` retry
// (session-lifecycle/engine.ts, deliverWithRetry) can land a second attempt
// well past the old TTL once the scheduler's drain tick is added on top. The
// old 60s TTL let exactly that combination through as an un-deduped double
// delivery. 10 minutes is not an arbitrary round number: it matches this
// system's own existing bound for "how stale can a retry be and still count
// as the same logical delivery" — UNDELIVERED_PROMPT_STARVATION_MS in
// session-lifecycle/undelivered-prompts.ts, the reconciler that re-drains a
// command stuck `queued` past 10 minutes. Choosing the same number means a
// prompt that reaches this cache's TTL boundary and a prompt that reaches the
// starvation reconciler's boundary expire at the same moment, instead of the
// dedupe window silently expiring first and leaving the starvation path to
// double-deliver into a fresh cache entry.
// F3: exported so `session-lifecycle/undelivered-prompts.ts` can derive its
// own starvation window FROM this value instead of independently hardcoding
// the same number — see `UNDELIVERED_PROMPT_STARVATION_MS` there. The
// no-blind-repost guarantee documented above requires
// `DEDUPE_TTL_MS >= UNDELIVERED_PROMPT_STARVATION_MS`; deriving one from the
// other makes that an invariant instead of a comment two files have to stay
// in sync by hand. `session-lifecycle` already imports from `sandbox-proxy`
// (engine.ts -> `../../sandbox-proxy/routes/preview`), so this follows the
// SAME existing module-boundary direction rather than opening a new one.
export const DEDUPE_TTL_MS = 10 * 60_000;
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

/**
 * Pull the wire `messageID` out of a `/prompt_async` or `/message` request
 * body, when present. Both endpoints' bodies carry a top-level `messageID`
 * string — the SDK's `promptOpenCodeMessage` mints one per logical submission
 * and reuses it on every retry of that submission
 * (`packages/sdk/src/react/use-opencode-sessions/messages.ts`,
 * `submissionWireId`). `/command` bodies never carry this field
 * (`{command,arguments,agent,model}`), so parsing them here simply finds
 * nothing and falls through to the content hash below — no per-endpoint
 * special-casing needed. Malformed JSON, a missing field, or a non-string
 * value all resolve to `null`, the same "fall back to the hash" outcome as a
 * body that never had the field at all.
 */
function extractWireMessageId(body: ArrayBuffer | undefined): string | null {
  if (!body || body.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const id =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).messageID
        : undefined;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Stable per-prompt key, in precedence order:
 *
 *  1. The caller's Idempotency-Key, when present (the CLI mints one UUID per
 *     logical prompt) — an explicit caller-supplied identity always wins.
 *  2. The body's wire `messageID`, when present (`/prompt_async` and
 *     `/message` from the SDK). This is the DURABLE identity: opencode itself
 *     is the arbiter of "has this already been answered?" by id order, so
 *     keying on the id — not the bytes — means a retry that reuses its id
 *     (submissionWireId) still collides here even if its body evolved, AND a
 *     genuinely new submission with byte-identical text (a user sending
 *     "continue" twice on purpose) never collides just because the words
 *     match. Scoped by sandbox + session, same as the hash below, so a
 *     message that landed on a sandbox before it rotated never blocks
 *     delivery to the sandbox that replaces it — that sandbox's opencode
 *     genuinely never saw it.
 *  3. A content hash — the near-duplicate shield for everything else
 *     (`/command`, or a body with no messageID field): retries of the SAME
 *     body still collide even from a client that sends no header and no id.
 */
export function promptDeliveryKey(opts: {
  idempotencyKey: string | null;
  sandboxId: string;
  sessionId: string;
  body: ArrayBuffer | undefined;
}): string {
  const provided = opts.idempotencyKey?.trim();
  if (provided) return `idem:${provided}`;
  const messageId = extractWireMessageId(opts.body);
  if (messageId) return `msgid:${opts.sandboxId}\0${opts.sessionId}\0${messageId}`;
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

// Release a claim taken by claimPromptDelivery when the delivery PROVABLY never
// reached opencode (the sandbox refused every connection, or the daemon returned
// "opencode not ready") — so a client retry with the same key re-attempts instead
// of short-circuiting to a bogus 200 "duplicate", which would silently drop the
// prompt (message loss). Only call this on a certain-not-delivered failure: on an
// AMBIGUOUS failure (5xx/timeout/reset where opencode may already hold the
// message) the claim must stay so a retry can't double-enqueue. A no-op for a key
// that was never claimed or already evicted.
export function releasePromptDelivery(key: string): void {
  seen.delete(key);
}

// Test-only: drop all cached claims so cases don't leak into one another.
export function __resetPromptDedupe(): void {
  seen.clear();
}
