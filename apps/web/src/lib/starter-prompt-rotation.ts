/**
 * Which starter prompts today's project home shows.
 *
 * The pool is ~100 prompts (`starter-prompts.ts`) and the band has six rows, so
 * the question is which five rotate under the pinned one — and the answer has
 * to be STABLE for a day. A set that reshuffled on every render would move the
 * row you were reaching for; a set that reshuffled on every refresh would make
 * the surface feel unreliable rather than varied.
 *
 * So: pick once, persist with an expiry, and re-pick only when that expiry has
 * passed. The check happens on page load, which is exactly when a person
 * refreshes and expects to maybe see something new.
 *
 * ## Why localStorage rather than a date-derived seed
 *
 * Seeding a PRNG from the calendar day would give the same answer with no
 * storage at all, and it is genuinely simpler. It is not what this does,
 * because it also gives EVERY person the same five prompts on the same day. A
 * stored random pick makes the rotation per-browser: two people opening Kortix
 * on the same morning see different work, which is the point of having a
 * hundred of them.
 *
 * ## Everything here is pure
 *
 * `random` and `now` are injected. That is not ceremony — a rotation that can
 * only be tested by mocking `Date` and `Math.random` is a rotation nobody
 * re-tests after changing it.
 *
 * Nothing here touches storage either. The persisted half is a zustand
 * `persist` store (`stores/starter-prompt-rotation-store.ts`), which owns the
 * disk key, the serialization, the quota-safe writes and the sign-out reset.
 * This module only answers "is that state still usable today, and if not, what
 * should replace it".
 */

export interface StarterRotation {
  /** The rotating picks, in display order. Ids, not indices — indices break
   *  silently the moment the pool is reordered. */
  ids: string[];
  /** Epoch ms. Absolute, so the check is one comparison and no arithmetic. */
  expiresAt: number;
}

/**
 * The next local midnight, in epoch ms.
 *
 * LOCAL, not UTC: "a new set every day" means the person's day. A UTC boundary
 * rolls the prompts mid-afternoon in Sydney and mid-evening in Los Angeles,
 * which reads as a glitch rather than a daily refresh.
 *
 * `setHours(24, 0, 0, 0)` rather than `setDate(getDate() + 1)`: the former is
 * defined across month and year ends and across daylight-saving shifts, where
 * the latter needs a branch for each.
 */
export function nextLocalMidnight(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

/**
 * How many recently-shown ids the next pick avoids — ten days at five a day.
 *
 * Without this the pick had no memory, and uniform random over 106 with 5 a day
 * measures at **22% of days repeating at least one of yesterday's prompts**,
 * worst case 4 of 5 identical. That is not "a new set every day", it is a new
 * draw every day, and the difference is exactly what a person notices.
 *
 * Ten days rather than forever: the point is that a prompt does not come back
 * while you still remember it, not that it is retired. 106 - 50 still leaves 56
 * candidates, so the exclusion can never starve the pick.
 */
export const RECENT_MEMORY = 50;

/**
 * `count` distinct ids, chosen with the supplied `random`, avoiding `recent`.
 *
 * A partial Fisher-Yates over the candidates: every subset is equally likely
 * and no id can repeat within a pick. The obvious alternative — pick a random
 * index `count` times and skip collisions — is both biased and unbounded as
 * `count` approaches the pool size.
 *
 * `recent` is an EXCLUSION, not a queue: ids seen in the last `RECENT_MEMORY`
 * picks are simply not candidates. When excluding them would leave fewer than
 * `count` candidates — a pool that shrank, or a corrupt oversized `recent` — it
 * falls back to the whole pool rather than returning a short band. Freshness is
 * a preference; a full band is a requirement.
 *
 * Returns fewer than `count` only when the pool itself is smaller, which the
 * caller treats as "show what there is" rather than as an error.
 */
export function pickRotation(
  ids: readonly string[],
  count: number,
  random: () => number,
  recent: readonly string[] = [],
): string[] {
  const excluded = new Set(recent);
  const fresh = ids.filter((id) => !excluded.has(id));

  const pool = fresh.length >= count ? fresh : [...ids];
  const take = Math.min(Math.max(count, 0), pool.length);

  // Both branches above are fresh arrays, so shuffling in place cannot touch
  // the caller's pool.
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, take);
}

/**
 * Whether a rehydrated rotation can be shown as-is.
 *
 * `false` means "pick a fresh one", and it covers six cases on purpose — every
 * one of them has to end in a re-pick rather than in a broken band:
 *
 * 1. Nothing persisted yet, so the store is on its empty defaults.
 * 2. The wrong shape — a hand-edited value, a half-written entry, or a key some
 *    future version repurposed. `persist` hands back whatever JSON parsed.
 * 3. Expired. The ordinary daily case.
 * 4. The wrong number of ids, because `count` changed with the layout.
 * 5. An id no longer in the pool. This is the one that matters after a deploy:
 *    prompts get renamed and removed, and a persisted id pointing at one that
 *    no longer exists would otherwise leave a gap in the band for the rest of
 *    the day.
 * 6. A duplicate id, which would render the same row twice.
 *
 * Takes `unknown` rather than `StarterRotation`, and that is the point: the
 * value has been through `localStorage`, which is shared with every other tab
 * and extension on the origin. It is treated as hostile input, not as something
 * this app wrote — the type says what we hope for, the function checks.
 */
export function isRotationUsable(
  state: unknown,
  now: number,
  poolIds: ReadonlySet<string>,
  count: number,
): boolean {
  if (!state || typeof state !== 'object') return false;
  const { ids, expiresAt } = state as Partial<StarterRotation>;

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  if (expiresAt <= now) return false;

  if (!Array.isArray(ids) || ids.length !== count) return false;
  if (!ids.every((id) => typeof id === 'string' && poolIds.has(id))) return false;
  if (new Set(ids).size !== ids.length) return false;

  return true;
}

/**
 * The next `recent` window: today's picks in front, capped at `RECENT_MEMORY`.
 *
 * Sanitises rather than trusts. `previous` has been through `localStorage`, so
 * it can be any shape; anything that is not a string or is no longer in the
 * pool is dropped, and duplicates are collapsed. An oversized or corrupt window
 * would otherwise quietly shrink the candidate set until `pickRotation` fell
 * back to the whole pool on every roll — the memory silently doing nothing,
 * which is the failure mode hardest to notice.
 */
export function nextRecent(
  picked: readonly string[],
  previous: unknown,
  poolIds: ReadonlySet<string>,
): string[] {
  const older = Array.isArray(previous)
    ? previous.filter((id): id is string => typeof id === 'string' && poolIds.has(id))
    : [];

  return [...new Set([...picked, ...older])].slice(0, RECENT_MEMORY);
}
