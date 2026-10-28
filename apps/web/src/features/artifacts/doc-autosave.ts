/**
 * The doc editor's autosave: framework-free, so its timing can be tested on a
 * fake clock. One save runs at a time, and each one names the version the
 * previous save made (`base_version`); edits made during a save wait and go out
 * as one follow-up save.
 *
 * A running session mounts Files, and its mount merges back after an API
 * write: the file gets a new version with the same text, or (two writes close
 * together) an older text again. So a 409 is not proof of another writer. The
 * saver reads the file and decides:
 * - the same text under a new version: take the version;
 * - a text this tab had at or before the one it edited: an older copy came
 *   back, write ours on top;
 * - anything else: another writer (an agent, another tab). Autosave stops and
 *   the person picks Reload or Keep mine.
 */

/** What the file holds, as far as this tab knows: the entry version and its Markdown. */
export type Known = { version: string | null; text: string };

export type DocSaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

export const AUTOSAVE_MS = 2_000;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 30_000;
/**
 * The least time between the end of one save and the start of the next. A
 * running session's Files mount can merge an older copy of the file back over
 * two writes that land closer together (measured locally: 2 of 4 lost at
 * 0–300 ms apart, 0 of 4 from 700 ms).
 * ponytail: spacing works around the storage merge; drop it when Platinum fixes it.
 */
export const SAVE_GAP_MS = 1_500;
/**
 * One look at the file this long after the last save: the mount's merge
 * lands after the save, and an idle editor would never see it.
 * ponytail: one look per idle; a live file watch if agents edit open docs often.
 */
export const VERIFY_MS = 4_000;
const MAX_HEALS = 3;

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface DocSaverDeps {
  artifactId: string;
  /** Write the entry; resolves to its new version. */
  write(text: string, baseVersion: string | null): Promise<string | null>;
  /** The entry now: its version and text. */
  read(): Promise<Known>;
  /** The editor's Markdown now. */
  text(): string;
  onStatus(status: DocSaveStatus): void;
  onConflict(): void;
  isConflict(err: unknown): boolean;
  timers?: Timers;
}

// replica-local: one browser tab.
const ownTexts = new Map<string, string[]>();
// replica-local: one browser tab.
const landing = new Map<string, Promise<Known | null>>();

/** A save makes `text` the newest; a load keeps the place it already has. */
function remember(artifactId: string, text: string, loaded = false) {
  const list = ownTexts.get(artifactId) ?? [];
  if (loaded && list.includes(text)) return;
  ownTexts.set(artifactId, [...list.filter((t) => t !== text).slice(-19), text]);
}

/** Where a text sits in this tab's history of the doc (newest last); -1 when this tab never had it. */
const ownIndex = (artifactId: string, text: string) => ownTexts.get(artifactId)?.lastIndexOf(text) ?? -1;

/**
 * Saves of this doc still on their way from an editor that closed, retries
 * included. The next editor opens on the outcome (null: open as given).
 */
export const pendingSave = (artifactId: string): Promise<Known | null> | undefined => landing.get(artifactId);

export function createDocSaver(start: Known, deps: DocSaverDeps) {
  const clock = deps.timers ?? realTimers;
  const id = deps.artifactId;
  remember(id, start.text, true);
  let known = start;
  let saving = false;
  let queued: string | null = null;
  let conflict = false;
  let closed = false;
  let heals = 0;
  let failures = 0;
  let ended = -Infinity;
  let debounce: unknown = null;
  let next: unknown = null;
  let verify: unknown = null;
  let settle: ((outcome: Known | null) => void) | null = null;

  const stop = (handle: unknown) => {
    if (handle !== null) clock.clear(handle);
    return null;
  };

  /** A save is queued or on its way: a next editor of this doc waits for the outcome. */
  const pending = () => {
    if (settle) return;
    const outcome = new Promise<Known | null>((resolve) => (settle = resolve));
    landing.set(id, outcome);
    void outcome.then(() => {
      if (landing.get(id) === outcome) landing.delete(id);
    });
  };

  /** The chain of saves is over: tell a next editor of this doc what the file holds. */
  const hand = (outcome: Known | null) => {
    settle?.(outcome);
    settle = null;
  };

  /** Run the queued save after `ms`. */
  const later = (ms: number) => {
    next = stop(next);
    next = clock.set(() => {
      next = null;
      const text = queued;
      queued = null;
      if (text !== null) void save(text);
    }, ms);
  };

  const enterConflict = () => {
    hand(null);
    // A closed editor leaves the file as it is; the next open shows it.
    if (closed) return;
    conflict = true;
    queued = null;
    deps.onStatus('conflict');
    deps.onConflict();
  };

  /** The file against `mine`, written on top of `base` (see the module comment). */
  const reconcile = (now: Known, mine: string, base: string): 'same' | 'ours' | 'theirs' => {
    if (now.text === mine) {
      known = now;
      return 'same';
    }
    const at = ownIndex(id, now.text);
    if (at < 0 || at > ownIndex(id, base) || heals >= MAX_HEALS) return 'theirs';
    heals += 1;
    known = now;
    queued = queued ?? mine;
    return 'ours';
  };

  const verifyLater = () => {
    verify = stop(verify);
    verify = clock.set(() => {
      verify = null;
      const at = known;
      // A closed editor never writes on its own: a restore may have put an older text back on purpose.
      if (closed || conflict || saving || queued !== null || debounce !== null) return;
      void deps.read().then((now) => {
        if (closed || known !== at || now.version === at.version) return;
        const verdict = reconcile(now, at.text, at.text);
        if (verdict === 'ours') later(0);
        if (verdict === 'theirs') enterConflict();
      }, () => {});
    }, VERIFY_MS);
  };

  const save = async (text: string): Promise<void> => {
    if (conflict) return;
    const wait = ended + SAVE_GAP_MS - clock.now();
    if (saving || wait > 0) {
      queued = text;
      pending();
      if (!saving) later(wait);
      return;
    }
    next = stop(next);
    const at = known;
    if (text === at.text) {
      hand(known);
      deps.onStatus(debounce !== null ? 'unsaved' : 'saved');
      return;
    }
    deps.onStatus('saving');
    remember(id, text);
    pending();
    saving = true;
    let after: number | null = 0;
    try {
      known = { version: await deps.write(text, at.version), text };
      failures = 0;
    } catch (err) {
      const now = deps.isConflict(err) ? await deps.read().catch(() => null) : null;
      const verdict = deps.isConflict(err) ? (now ? reconcile(now, text, at.text) : 'theirs') : null;
      if (verdict === 'theirs') {
        after = null;
        enterConflict();
      } else if (!verdict) {
        // Keep the edit and try again, backing off. The API client already toasts the error.
        queued = queued ?? text;
        deps.onStatus('error');
        after = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures);
        failures += 1;
        hand(null);
      }
    } finally {
      saving = false;
      ended = clock.now();
    }
    if (after === null) return;
    if (queued !== null) return later(Math.max(after, SAVE_GAP_MS));
    heals = 0;
    hand(known);
    deps.onStatus(debounce !== null ? 'unsaved' : 'saved');
    verifyLater();
  };

  return {
    /** The editor changed: save after AUTOSAVE_MS of quiet. */
    edited() {
      if (conflict) return;
      deps.onStatus('unsaved');
      debounce = stop(debounce);
      debounce = clock.set(() => {
        debounce = null;
        void save(deps.text());
      }, AUTOSAVE_MS);
    },
    /** Save now (⌘S, leaving), when an edit waits. */
    flush() {
      if (debounce === null) return;
      debounce = stop(debounce);
      void save(deps.text());
    },
    /** The conflict's Keep mine: write this tab's text over theirs, then autosave resumes. */
    keepMine() {
      conflict = false;
      known = { version: null, text: '' };
      void save(deps.text());
    },
    /** Something is not in the file yet. */
    busy: () => debounce !== null || saving || next !== null || conflict,
    /** The editor goes away: save what waits, then never write on its own again. */
    close() {
      this.flush();
      closed = true;
      verify = stop(verify);
    },
  };
}

export type DocSaver = ReturnType<typeof createDocSaver>;
