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
 * The TTL matches `PROVISION_ATTEMPT_TTL_MS` in `lib/onboarding/ensure-first-project.ts`
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

function mint(): string {
  return crypto.randomUUID();
}

export function attemptKeyFor(fingerprint: string, now: number): string {
  const store = storage();
  if (!store) return mint();

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
  try {
    storage()?.removeItem(PREFIX + fingerprint);
  } catch {
    // Nothing to do — the key ages out on its own.
  }
}
