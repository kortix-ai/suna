import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  isRotationUsable,
  nextLocalMidnight,
  nextRecent,
  pickRotation,
} from '@/lib/starter-prompt-rotation';
import {
  GENERAL_STARTER_PROMPT_IDS,
  ROTATING_STARTER_PROMPT_IDS,
  WORKFORCE_STARTER_PROMPT_IDS,
} from '@/lib/starter-prompts';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * Which five starter prompts today's project home shows under the pinned one.
 *
 * The rules — local midnight, unbiased pick, what makes a persisted set stale —
 * are in `lib/starter-prompt-rotation.ts` and are pure. This file is the
 * persisted half, and it is a zustand `persist` store rather than hand-rolled
 * `localStorage` for three reasons, each of which is infrastructure this repo
 * already owns and a hand-rolled version silently opts out of:
 *
 * 1. **`createSafeJSONStorage()`** (`lib/storage/managed-storage.ts`). The
 *    origin shares ONE ~5-10MB bucket across every store and cache. A bare
 *    `setItem` that throws `QuotaExceededError` crashes whatever wrote next,
 *    which is how a tiny innocent write became a crash site before. This
 *    storage never throws AND reclaims space by evicting disposable caches
 *    before retrying — a `try {} catch {}` of my own would only have swallowed
 *    the error and left the bucket just as full.
 * 2. **`registerPersistedStore`** (`stores/persisted-store-registry.ts`), so
 *    the in-memory state resets on sign-out without `reset-client-state.ts`
 *    having to import this module.
 * 3. **`persisted-store-coverage.test.ts`**, which walks THIS directory and
 *    fails closed if a persisted store's key is neither swept nor explicitly
 *    kept, or if it never registers itself. A module in `lib/` is invisible to
 *    that test — not covered is not governed.
 *
 * ## Resolved once per page load
 *
 * `refresh()` runs at module scope, below, and nowhere else. `persist` with a
 * synchronous storage rehydrates during `create()`, so by the time that line
 * runs the persisted set is already in state and the check is a plain
 * comparison — no effect, no second render, no empty band on first paint.
 *
 * It deliberately does NOT re-check at midnight under an open tab. The expiry
 * is read when the page LOADS, which is when a person refreshes and expects to
 * maybe see something new; swapping five rows out from under someone
 * mid-sentence would be the worse product.
 */

/**
 * How many rows rotate.
 *
 * The band renders SIX rows and the first is pinned (`starter-prompt-band.tsx`),
 * so five rotate. Change the band and change this together — a mismatch means
 * `isRotationUsable` rejects the persisted set on its length check and re-picks
 * on every single load, which looks like the feature working and is actually
 * the cache being dead.
 */
export const ROTATION_SIZE = 5;

/** `persist`'s disk key. `kortix.` matches `APP_STORAGE_PREFIXES`, so it is
 *  swept on sign-out — asserted by `persisted-store-coverage.test.ts`. */
const STORAGE_KEY = 'kortix.starterPrompts';

/**
 * **Bump this to reshuffle every browser.**
 *
 * `persist` compares the stored version against this one and, with no `migrate`
 * function declared, DISCARDS a mismatched entry rather than trying to read it.
 * The store falls back to its empty defaults, the module-scope `refresh()`
 * below sees an unusable rotation, and every browser picks a fresh set on its
 * next load. It clears `recent` too, so the ten-day no-repeat window restarts.
 *
 * That is the lever for "the prompt list changed, get everyone off the old
 * one". You do NOT need it for ordinary edits: renaming a prompt's id already
 * drops it from anyone holding it (`isRotationUsable` checks every id against
 * the pool), and the daily expiry re-picks by itself. Bump it when you want the
 * change to land today rather than tomorrow.
 */
const STORAGE_VERSION = 1;

const POOL_IDS: ReadonlySet<string> = new Set(ROTATING_STARTER_PROMPT_IDS);

/**
 * One of the five rows is RESERVED for a workforce prompt — create an agent,
 * write a skill, schedule a trigger.
 *
 * A uniform pick across the whole pool does not survive the pool growing. At
 * 18 workforce prompts in 185, **60% of days would show none of them**, and the
 * band would read as generic knowledge work five days out of eight — undoing
 * the entire point of that group. Reserving one slot makes it every day, and
 * costs one row of variety out of five.
 *
 * Both halves are drawn with the same `recent` exclusion, so the reservation
 * does not weaken the no-repeat guarantee. The general half additionally
 * excludes the workforce pick, which cannot collide anyway — the two id sets
 * are disjoint by construction — but says so rather than relying on it.
 */
function pickDay(recent: readonly string[], random: () => number): string[] {
  const workforce = pickRotation(WORKFORCE_STARTER_PROMPT_IDS, 1, random, recent);
  const general = pickRotation(GENERAL_STARTER_PROMPT_IDS, ROTATION_SIZE - 1, random, [
    ...recent,
    ...workforce,
  ]);

  // Shuffled together, so the workforce row is not always in the same position.
  // No `recent` here: this call only reorders the five already chosen.
  return pickRotation([...workforce, ...general], ROTATION_SIZE, random);
}

interface StarterRotationState {
  /** Today's picks. Empty until `refresh()` has run — which, on the client,
   *  is before any component can read it. */
  ids: string[];
  expiresAt: number;
  /**
   * The ids shown over the last ten rolls, newest first, so tomorrow's pick can
   * avoid them. Without it the pick had no memory and 22% of days repeated at
   * least one of yesterday's prompts — measured, not estimated. See
   * `RECENT_MEMORY`.
   */
  recent: string[];
  /** Re-pick unless the current set is still usable. Idempotent, so calling it
   *  twice in one page costs one comparison and changes nothing. */
  refresh: (now?: number) => void;
  /**
   * Re-pick NOW, at the person's request. Called by the shuffle control in
   * `starter-prompt-band.tsx` and nowhere else.
   *
   * Deliberately does NOT extend the expiry past tonight. Shuffling is "show me
   * different ones", not "restart my day" — a shuffle at noon still rolls again
   * at midnight, so a person who presses it once does not silently opt out of
   * the daily rhythm for the next 24 hours.
   *
   * It respects `recent` for the same reason `refresh` does: pressing it
   * repeatedly walks the pool the way consecutive days do, and cannot serve up
   * anything from the last ten sets. A shuffle that ignored the memory would
   * hand back a prompt you rejected two presses ago.
   */
  reshuffle: () => void;
}

export const useStarterRotationStore = create<StarterRotationState>()(
  persist(
    (set) => ({
      ids: [],
      expiresAt: 0,
      recent: [],
      refresh: (now = Date.now()) =>
        set((state) => {
          if (isRotationUsable(state, now, POOL_IDS, ROTATION_SIZE)) return state;

          const ids = pickDay(state.recent, Math.random);

          return {
            ids,
            expiresAt: nextLocalMidnight(now),
            recent: nextRecent(ids, state.recent, POOL_IDS),
          };
        }),
      reshuffle: () =>
        set((state) => {
          const ids = pickDay(state.recent, Math.random);
          return {
            ids,
            expiresAt: nextLocalMidnight(Date.now()),
            recent: nextRecent(ids, state.recent, POOL_IDS),
          };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: STORAGE_VERSION,
      // Only the data. `refresh` is a function and JSON would drop it anyway,
      // but saying so keeps the persisted shape exactly what `isRotationUsable`
      // is written against.
      partialize: (state) => ({
        ids: state.ids,
        expiresAt: state.expiresAt,
        recent: state.recent,
      }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useStarterRotationStore));

/*
 * Resolve today's set at import time, on the client only.
 *
 * At module scope rather than in a component effect: an effect runs after the
 * first paint, so the band would render its pinned row alone for a frame and
 * then grow by five — a visible flicker on every project open, for a value that
 * is available synchronously.
 *
 * The server has neither storage nor the person's local midnight, so it renders
 * the empty default. In practice it never even gets that far: the band mounts
 * only once `ProjectSetupChecklist` has resolved, which cannot happen on the
 * server.
 */
if (typeof window !== 'undefined') {
  useStarterRotationStore.getState().refresh();
}
