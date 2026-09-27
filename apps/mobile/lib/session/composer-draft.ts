/**
 * Composer drafts (COR-143) — the pure half. Keys, the write rule, pruning,
 * and the keyed debouncer. No React, no storage: `stores/composer-draft-store.ts`
 * persists the result and `lib/session/use-composer-draft.ts` wires a composer.
 *
 * Web's model (`apps/web/src/features/session/composer/draft/composer-draft.ts`):
 * one draft per project home and one per session; an emptied composer removes
 * its draft through the same write; an oversized draft is not kept; only the
 * most recently written drafts survive, so drafts of deleted sessions age out
 * without a deletion hook. Mobile stores plain text: its composer has no
 * mention atoms to round-trip, and picked files are local URIs the OS may
 * reclaim, so attachments are not saved.
 */

/** Where a draft belongs. Both ids are UUIDs, so the two families never collide. */
export type DraftScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

export function draftKey(scope: DraftScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : `session:${scope.sessionId}`;
}

export interface StoredDraft {
  text: string;
  /** Epoch ms of the last write; pruning keeps the newest. */
  at: number;
}

export type DraftMap = Record<string, StoredDraft>;

/**
 * Per-draft ceiling, in characters. All drafts share one AsyncStorage entry,
 * and Android caps one entry near 2 MB, so a pasted log must not fill it.
 * A draft over the ceiling is not kept (web's `MAX_DRAFT_BYTES` rule).
 */
export const MAX_DRAFT_CHARS = 20_000;

/** How many drafts survive: the most recently written. */
export const MAX_DRAFTS = 30;

/** Delay between the last keystroke and the write. */
export const DRAFT_WRITE_DELAY_MS = 400;

/**
 * The draft map after writing `text` under `key`. Blank text, or text over
 * the ceiling, removes the key. Returns the same object when nothing changes,
 * so a no-op write does not touch storage.
 */
export function applyDraftWrite(drafts: DraftMap, key: string, text: string, now: number): DraftMap {
  const keep = text.trim().length > 0 && text.length <= MAX_DRAFT_CHARS;
  if (!keep) {
    if (!(key in drafts)) return drafts;
    const next = { ...drafts };
    delete next[key];
    return next;
  }
  if (drafts[key]?.text === text) return drafts;
  return pruneDrafts({ ...drafts, [key]: { text, at: now } }, MAX_DRAFTS);
}

/** Keeps the `max` most recently written drafts. */
export function pruneDrafts(drafts: DraftMap, max: number): DraftMap {
  const keys = Object.keys(drafts);
  if (keys.length <= max) return drafts;
  const newest = keys.sort((a, b) => drafts[b]!.at - drafts[a]!.at).slice(0, max);
  const next: DraftMap = {};
  for (const key of newest) next[key] = drafts[key]!;
  return next;
}

/** The text to restore for `key`, or '' for none. Tolerates a malformed entry. */
export function readDraftText(drafts: DraftMap | undefined, key: string): string {
  const entry = drafts?.[key];
  return entry && typeof entry.text === 'string' ? entry.text : '';
}

type Timer = ReturnType<typeof setTimeout>;

export interface KeyedDebouncer {
  /** Runs `run` after the delay, replacing any pending run for `key`. */
  schedule: (key: string, run: () => void) => void;
  /** Drops the pending run for `key` without running it. */
  cancel: (key: string) => void;
  /** Drops every pending run. */
  cancelAll: () => void;
  /** Runs every pending run now (the app is going to the background). */
  flush: () => void;
}

export function createKeyedDebouncer(
  delayMs: number,
  timers: { set: (fn: () => void, ms: number) => Timer; clear: (timer: Timer) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (timer) => clearTimeout(timer),
  },
): KeyedDebouncer {
  const pending = new Map<string, { timer: Timer; run: () => void }>();
  const cancel = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    timers.clear(entry.timer);
    pending.delete(key);
  };
  return {
    schedule(key, run) {
      cancel(key);
      const timer = timers.set(() => {
        pending.delete(key);
        run();
      }, delayMs);
      pending.set(key, { timer, run });
    },
    cancel,
    cancelAll() {
      for (const key of [...pending.keys()]) cancel(key);
    },
    flush() {
      const runs = [...pending.values()];
      for (const { timer } of runs) timers.clear(timer);
      pending.clear();
      for (const { run } of runs) run();
    },
  };
}
