/**
 * A stable `idempotency_key` for one create attempt on `/new`.
 *
 * `POST /v1/projects/provision` mints a brand-new managed repo per call, so a
 * reload, a second tab, or a retry after a lost response used to create a real
 * duplicate workspace with its own upstream repo. The key is what stops that.
 *
 * Per the API contract in `apps/api/src/projects/routes/r1.ts`, the key
 * identifies the ATTEMPT, not the payload — the same key with a different name
 * returns the FIRST project and silently ignores the new payload. So the
 * fingerprint passed in by the caller must include everything that makes a
 * create *distinct*, and the key must be reused only across retries of the
 * same create.
 *
 * The TTL matches `PROVISION_ATTEMPT_TTL_MS` in `lib/onboarding/ensure-first-workspace.ts`
 * and is chosen against the slowest provision this repo documents — a snapshot
 * build of up to ~9 min. At 6x that ceiling the bound can never expire a key
 * while the attempt it identifies could still be committing.
 */
const TTL_MS = 60 * 60 * 1000;
const PREFIX = 'kortix:new-workspace-key:';

interface StoredAttempt {
  key: string;
  mintedAt: number;
}

function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
  } catch {
    // Private browsing / blocked storage. A per-call key is still correct for
    // the happy path; only cross-reload dedupe is lost.
    return undefined;
  }
}

/**
 * In-memory fallback for `attemptKeyFor`/`clearAttemptKey`, consulted only
 * when `storage()` is unavailable (private browsing, blocked storage).
 *
 * Before Task 14 wired `retry` into a clickable control
 * (`new-workspace-page.tsx`), the only way to re-run a create was
 * resubmitting the whole form, so minting a fresh key on every
 * storage-unavailable call was low-frequency — at most one extra key per
 * manual resubmit. With a retry BUTTON, a user in a storage-blocked browser
 * can click it repeatedly, and a fresh key per click mints a fresh upstream
 * managed repo per click — the exact failure idempotency exists to prevent.
 * This map keeps the minted key stable across calls with the SAME
 * fingerprint for the lifetime of the page load even with nothing
 * persistable. Cross-reload dedupe is still lost without storage, unchanged
 * from before — only the "click retry twice in one session" case is fixed.
 */
const memoryFallback = new Map<string, StoredAttempt>();

/**
 * Test-only. `memoryFallback` is process/module-level state, so without this
 * two test CASES sharing a fingerprint (a realistic thing to do — most tests
 * in this file reuse `'acct-1:suna-web'`) would leak a minted key from one
 * case into the next. Mirrors `resetAiIndexRateLimitsForTests`
 * (`lib/seo/rate-limit.ts`), the same pattern for the same reason.
 */
export function resetAttemptKeyMemoryFallbackForTests(): void {
  memoryFallback.clear();
}

function mint(): string {
  return crypto.randomUUID();
}

export function attemptKeyFor(fingerprint: string, now: number): string {
  const store = storage();
  if (!store) {
    const cached = memoryFallback.get(fingerprint);
    if (cached?.key && now - cached.mintedAt < TTL_MS) return cached.key;
    const key = mint();
    memoryFallback.set(fingerprint, { key, mintedAt: now });
    return key;
  }

  const slot = PREFIX + fingerprint;
  try {
    const raw = store.getItem(slot);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredAttempt;
      if (parsed?.key && now - parsed.mintedAt < TTL_MS) return parsed.key;
    }
  } catch {
    // Corrupt value — fall through and mint a fresh one.
  }

  const key = mint();
  try {
    store.setItem(slot, JSON.stringify({ key, mintedAt: now } satisfies StoredAttempt));
  } catch {
    // Quota or blocked storage. The key is still valid for this call.
  }
  return key;
}

export function clearAttemptKey(fingerprint: string): void {
  // Unconditional, not gated on whether storage is available right now: a
  // key minted while storage was unavailable lives ONLY in `memoryFallback`,
  // and a later call with storage restored would never look there, so a
  // clear that skipped this would leave that key live forever (until TTL) —
  // the next same-name create would silently return the OLD workspace.
  memoryFallback.delete(fingerprint);
  try {
    storage()?.removeItem(PREFIX + fingerprint);
  } catch {
    // Nothing to do — the key ages out on its own.
  }
}
