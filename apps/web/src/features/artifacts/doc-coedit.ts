/**
 * Live co-editing of one doc Artifact (KRTX-3670, WP4): the orchestration,
 * framework-free so its timing runs on a fake clock. It owns the `Y.Doc` the
 * editor binds to (`doc-coedit-editor.tsx`) and drives the sync engine
 * (`createArtifactDocSync`, `@kortix/sdk`): every local Yjs update is pushed,
 * every pulled one is applied with `REMOTE_ORIGIN` and never pushed back.
 *
 * The Markdown file in Files stays the truth. One tab writes it: the leader,
 * the tab that holds the doc's lease. Its duties:
 * - write the editor's Markdown `AUTOSAVE_MS` after the last change (its own
 *   or another tab's), with `base_version`, one write at a time and
 *   `SAVE_GAP_MS` apart, then record the flush (`flushed`);
 * - meet a 409 as `doc-autosave.ts` does (`fileVerdict`): the same text under
 *   a new version is taken; an older text of this tab is written over;
 *   anything else is an outside edit, merged into the live doc
 *   (`applyOutsideEdit`, WP5) and written again;
 * - on a `changed content` ping (`fileMoved`), the same: a new text that is
 *   not this tab's is merged at once;
 * - on taking the lease, catch up: a file that changed since the last flush
 *   is merged in; a doc whose Markdown the file lacks (the last leader left
 *   within 2 s of an edit) is written.
 *
 * A file text the live doc already passed through (sampled after each change
 * settles) is never merged back in: it is a leader's write whose flush record
 * never landed (the tab died between the two), or an older copy the Files
 * mount put back. Merging it would duplicate what the doc holds; the leader
 * writes the doc over it instead. A deliberate restore wins over that rule:
 * it records a `restored` event in Activity (`restores`), a mount heal does
 * not, so an older text that comes with a new restore event is merged in as
 * any outside edit.
 *
 * A tab that does not lead never writes and ignores `fileMoved`. A read-only
 * viewer never seeds, pushes or leads: it applies pulled updates only.
 *
 * A reset (contract v2: the GC deleted the doc state, it was seeded again
 * under another epoch, or a stored update was poisoned) ends the doc this
 * tab loaded. The orchestration loads the doc again on a fresh `Y.Doc` (the
 * seed always from the file, read fresh), asks the host to bind the editor
 * to it (`onRebind`), and then puts the person's text back as text: the
 * editor's Markdown when the reset landed (`mine`) onto the rebuilt doc,
 * from the last text both had (`recover`, `doc-coedit-merge.ts`). A
 * read-only viewer rebuilds and merges nothing.
 *
 * Co-editing ends for good (`onFallback`) when the engine fails: one update
 * over 512 KiB (`too-large`), the doc's stored history over 16 MiB
 * (`history-too-large`), a read-only viewer whose doc nobody seeded again
 * (`unseeded`), or any refusal it cannot retry (`failed`). The host then
 * reopens the doc with single-writer autosave.
 */

import {
  createArtifactDocSync,
  type ArtifactDocBase,
  type ArtifactDocSeed,
  type ArtifactDocSync,
  type ArtifactDocSyncOptions,
  type ArtifactDocSyncStatus,
  type EventStreamTimerHandle,
  type EventStreamTimers,
} from '@kortix/sdk';
import * as Y from 'yjs';

import {
  AUTOSAVE_MS,
  SAVE_GAP_MS,
  fileVerdict,
  remember,
  type DocSaveStatus,
  type Known,
  type Timers,
} from './doc-autosave';

/** The Y fragment the editor binds to (tiptap Collaboration's default). */
export const COEDIT_FIELD = 'default';
/** The Yjs origin of every update the engine pulled: never pushed back. */
export const REMOTE_ORIGIN = Symbol('artifact-doc-remote');
/** How long a comment waits for the file to hold the doc's text. */
export const SNAPSHOT_MS = 8_000;
const SNAPSHOT_POLL_MS = 1_000;
/** A push slower than this shows "Saving…"; a faster one shows nothing. */
const SLOW_SYNC_MS = 1_000;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 30_000;
/** Older texts of this tab written over in a row before the leader backs off. */
const MAX_HEALS = 3;
/**
 * A restore writes the file, then records its Activity event: an older text
 * without a new restore event is asked about once more after this long
 * before it counts as a Files mount heal.
 */
const RESTORE_RECHECK_MS = 1_000;
/** A read-only viewer of a doc nobody seeded asks this often (the engine's own poll). */
export const SEED_POLL_MS = 3_000;
/**
 * After a reset, the tabs put their text back one at a time: two unions
 * inserted at once would both stay in the doc. Each tab marks itself in
 * the doc's `RECOVERY_KEY` map, waits `RECOVERY_SETTLE_MS` for the marks
 * of tabs that reset with it, then recovers after every tab with a lower
 * holder id is done (at most `RECOVERY_WAIT_MS`: a tab that closed meanwhile
 * never finishes).
 */
export const RECOVERY_KEY = 'kortix.recovery';
export const RECOVERY_SETTLE_MS = 500;
const RECOVERY_WAIT_MS = 5_000;
const RECOVERY_POLL_MS = 250;
/**
 * Quiet time after a change before the doc's Markdown counts as a state the
 * doc passed through. A leader writes only after `AUTOSAVE_MS` of quiet, so
 * every tab sees each written state settle for longer than this.
 */
const SETTLED_MS = 500;
const PASSED_MAX = 64;

/** cyrb53: a 53-bit string hash, base 36 (as doc-fidelity.ts). */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Why co-editing ended: one update over the server's limit, the doc's stored
 * history over its cap (`413 doc_too_large`), a read-only viewer with no
 * doc to load (it waits for a seed), or a refusal the engine cannot retry.
 */
export type CoeditFallback = 'too-large' | 'history-too-large' | 'unseeded' | 'failed';

/** A read-only viewer opened a doc nobody seeded yet: it shows the file instead. */
export class CoeditUnavailable extends Error {}
/**
 * The shared doc holds a root node the editor cannot bind to (y-tiptap renders
 * only XML elements at the root): never mount on it; the host opens the file
 * with autosave.
 */
export class CoeditUnrenderable extends Error {}

/**
 * Whether the editor can bind to `doc`: y-tiptap renders only XML elements at
 * the root of the fragment and throws on anything else (a text node a raw
 * Yjs writer put there).
 */
export function bindable(doc: Y.Doc): boolean {
  return doc
    .getXmlFragment(COEDIT_FIELD)
    .toArray()
    .every((child) => child instanceof Y.XmlElement);
}

/** Each live doc's session, told when an editor could not bind to the doc (`reportUnrenderable`). */
const unrenderableHandlers = new WeakMap<Y.Doc, () => void>();

/** The editor could not bind to `doc` (doc-coedit-editor.tsx): its session falls back. */
export function reportUnrenderable(doc: Y.Doc): void {
  unrenderableHandlers.get(doc)?.();
}

/** The editor as the leader needs it. */
export interface CoeditEditor {
  /** The editor's Markdown now (what a write puts in the file). */
  markdown(): string;
  /** Merge an outside edit (`base` → `theirs`) into the live doc: one transaction, outside the undo history. */
  merge(base: string, theirs: string): { changed: boolean; conflicts: number };
  /**
   * After a reset: put the person's text (`mine`) onto the rebuilt doc, from
   * the last text both had (`base`), keeping what the rebuilt doc holds.
   * Default: `merge(base, mine)`.
   */
  recover?(base: string, mine: string): { changed: boolean; conflicts: number };
  /** Before a reset rebinds: where the caret is (for `restoreView`); the editor stops taking input. */
  saveView?(): unknown;
  /** After a reset rebinds: the caret (and focus) where `saveView` found it. */
  restoreView?(view: unknown): void;
}

export interface DocCoeditDeps {
  projectId: string;
  artifactId: string;
  /** This tab's lease id (a random UUID). */
  holder: string;
  /** View access only: never seeds, pushes, leads or writes. */
  readOnly: boolean;
  /** The file as this tab opened it; its version is not null. */
  opened: Known;
  /** A Yjs update of a scratch doc that holds `markdown` as the editor loads it, fragment `COEDIT_FIELD`. */
  seed(markdown: string): Uint8Array;
  /** Write the entry on top of `baseVersion`; resolves to its new version. */
  write(text: string, baseVersion: string | null): Promise<string | null>;
  /** The entry now. */
  read(): Promise<Known>;
  isConflict(err: unknown): boolean;
  /**
   * The ids of the newest `restored` events in the Artifact's Activity. A new
   * one tells a deliberate restore from a Files mount heal. Absent: every
   * older text of this tab counts as a heal.
   */
  restores?(): Promise<string[]>;
  /**
   * Whether the doc has a live state now. A read-only viewer may not seed:
   * after a reset it waits (every `SEED_POLL_MS`) until an editor seeded the
   * doc again, then loads it. Absent: it loads at once (and falls back to
   * `unseeded` when nobody seeded yet).
   */
  seeded?(): Promise<boolean>;
  onStatus(status: DocSaveStatus): void;
  onFallback(reason: CoeditFallback): void;
  /** A reset loaded the doc again on a fresh `Y.Doc` (`doc`): bind the editor to it, then `attach`. */
  onRebind?(): void;
  onLeader?(leader: boolean): void;
  timers?: Timers;
  /** The engine. Default: `createArtifactDocSync`; tests pass a fake. */
  createSync?: (options: ArtifactDocSyncOptions) => ArtifactDocSync;
}

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** `start`, `flushed` and `base` reject with this code when the engine reset the doc. */
const isDocReset = (error: unknown) => codeOf(error) === 'doc_reset';
/** Why the engine failed, as a fallback. */
const reasonOf = (error: unknown): CoeditFallback =>
  codeOf(error) === 'doc_too_large' ? 'history-too-large' : statusOf(error) === 413 ? 'too-large' : 'failed';

export function createDocCoedit(deps: DocCoeditDeps) {
  const clock = deps.timers ?? realTimers;
  const id = deps.artifactId;
  /** The doc the editor binds to. */
  let doc = new Y.Doc();
  /** The doc `apply` writes to: `doc`, or a fresh one while a reset loads. */
  let target = doc;
  /** After a reset: the doc the editor was bound to, destroyed once the editor binds to the new one. */
  let staleDoc: Y.Doc | null = null;
  /** After a reset: the person's text, put back once the editor binds to the new doc. */
  let recovery: { base: string; mine: string } | null = null;
  /** After a reset: the old editor's caret, for the new one. */
  let savedView: unknown = null;
  /** A load (the first, or after a reset) is running; a reset meanwhile loads again. */
  let loading = false;
  let resetAgain = false;
  /** A read-only viewer found no doc to load: it waits for a seed. */
  let unseeded = false;

  let editor: CoeditEditor | null = null;
  let leader = false;
  /** `start` resolved: the host mounts the editor on `doc`. */
  let started = false;
  /** Closed, or fell back: nothing runs any more. */
  let ended = false;
  let closed = false;
  /** The file as this tab last read or wrote it: the next write's base. */
  let known: Known = deps.opened;
  /** The file text the live doc last took in (written from it, or merged into it): an outside edit's base. */
  let mergeBase = deps.opened.text;
  /** The last flush recorded with the engine. */
  let recorded: Known | null = null;
  /** This tab changed the doc since its last write began (only counts while it leads). */
  let localDirty = false;
  let writing = false;
  let writeFailing = false;
  let failures = 0;
  let heals = 0;
  let lastWriteEnd = -Infinity;
  let lastError: unknown = null;
  /** The restore events Activity held when this tab took the lease, and every one met since; null: unknown. */
  let knownRestores: Set<string> | null = null;

  let engineStatus: ArtifactDocSyncStatus = 'connecting';
  let slow = false;
  let reported: DocSaveStatus | null = null;

  let debounce: unknown = null;
  let retry: unknown = null;
  let gap: unknown = null;
  let slowTimer: unknown = null;
  let sampleTimer: unknown = null;
  let recoveryTimer: unknown = null;
  /** Hashes of the Markdown states this doc settled in (newest last). */
  let passed: string[] = [];

  const want = { takeover: false, moved: false, flush: false };
  let movedVersion: string | null = null;
  let running: Promise<void> | null = null;
  const idleWaiters: Array<() => void> = [];

  remember(id, deps.opened.text, true);

  const stop = (handle: unknown) => {
    if (handle !== null) clock.clear(handle);
    return null;
  };
  const stopAll = () => {
    debounce = stop(debounce);
    retry = stop(retry);
    gap = stop(gap);
    slowTimer = stop(slowTimer);
    sampleTimer = stop(sampleTimer);
    recoveryTimer = stop(recoveryTimer);
  };

  /** The attached editor's Markdown; null (and detached) when it went away under us. */
  const readMarkdown = (): string | null => {
    if (!editor) return null;
    try {
      return editor.markdown();
    } catch {
      editor = null;
      return null;
    }
  };
  const notePassed = (text: string) => {
    const hash = hashText(text);
    passed = [...passed.filter((h) => h !== hash).slice(-(PASSED_MAX - 1)), hash];
  };
  const hasPassed = (text: string) => passed.includes(hashText(text));
  /** After a change settles, its Markdown is a state the doc passed through. */
  const sample = () => {
    if (deps.readOnly) return;
    sampleTimer = stop(sampleTimer);
    sampleTimer = clock.set(() => {
      sampleTimer = null;
      const text = ended ? null : readMarkdown();
      if (text !== null) notePassed(text);
    }, SETTLED_MS);
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => void clock.set(resolve, ms));

  // ── Status ────────────────────────────────────────────────────────────────

  /** "Is my work safe": saved once on the server; Saving… only when a push takes long; error while retrying. */
  const report = () => {
    if (ended) return;
    const next: DocSaveStatus =
      engineStatus === 'retrying' || writeFailing
        ? 'error'
        : engineStatus === 'connecting' || engineStatus === 'reset' || slow
          ? 'saving'
          : 'saved';
    if (next === reported) return;
    reported = next;
    deps.onStatus(next);
  };

  const fallBack = (reason: CoeditFallback) => {
    if (ended) return;
    ended = true;
    stopAll();
    unlisten();
    settle();
    deps.onFallback(reason);
  };

  const engineChanged = (status: ArtifactDocSyncStatus) => {
    engineStatus = status;
    if (status === 'syncing') {
      if (slowTimer === null && !slow)
        slowTimer = clock.set(() => {
          slowTimer = null;
          slow = true;
          report();
        }, SLOW_SYNC_MS);
    } else {
      slowTimer = stop(slowTimer);
      slow = false;
    }
    if (status === 'failed') return fallBack(unseeded ? 'unseeded' : reasonOf(lastError));
    report();
  };

  // ── The engine ────────────────────────────────────────────────────────────

  const engineTimers: EventStreamTimers = {
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.set(fn, ms ?? 0) as EventStreamTimerHandle,
    clearTimeout: (handle) => {
      if (handle !== undefined) clock.clear(handle);
    },
  };
  /**
   * A pulled update left a root node the editor cannot render. `apply`
   * throws it, so the engine treats the row as poisoned and resets the doc
   * when this tab may (the server refuses a viewer); the next open rebuilds
   * it from the file. A mounted tab falls back to autosave once the engine
   * sent the reset; a tab still loading never mounts (`start`).
   */
  const unrenderable = () => {
    if (started) queueMicrotask(() => fallBack('failed'));
    return new CoeditUnrenderable('The shared doc holds a root node the editor cannot render');
  };
  const sync = (deps.createSync ?? createArtifactDocSync)({
    projectId: deps.projectId,
    artifactId: deps.artifactId,
    holder: deps.holder,
    apply: (update) => {
      // A mounted editor's binding throws on such a node too; the check is the same either way.
      let failure: unknown = null;
      try {
        Y.applyUpdate(target, update, REMOTE_ORIGIN);
      } catch (error) {
        failure = error;
      }
      if (!bindable(target)) throw unrenderable();
      if (failure) throw failure;
    },
    merge: (updates) => Y.mergeUpdates(updates),
    onLeader: (next) => setLeader(next),
    onStatus: engineChanged,
    onError: (error) => {
      lastError = error;
    },
    onReset: () => onEngineReset(),
    ...(deps.timers ? { timers: engineTimers } : {}),
  });

  function onUpdate(source: Y.Doc, update: Uint8Array, origin: unknown) {
    // The old doc while a reset loads: what the person types there comes back as text (`recovery`).
    if (ended || source !== target) return;
    if (origin !== REMOTE_ORIGIN) {
      if (deps.readOnly) return;
      localDirty = true;
      sync.push(update);
    }
    // The fresh doc before the editor binds to it.
    if (source !== doc) return;
    sample();
    changed();
  }
  function listen(source: Y.Doc): () => void {
    const handler = (update: Uint8Array, origin: unknown) => onUpdate(source, update, origin);
    source.on('update', handler);
    return () => source.off('update', handler);
  }
  let unlisten = listen(doc);
  /** The editor could not bind to the doc: autosave on what this tab has. */
  const onUnrenderable = () => fallBack('failed');
  unrenderableHandlers.set(doc, onUnrenderable);

  // ── Loading, and a reset ──────────────────────────────────────────────────

  /** A seed is always the file as it is now (contract v2), built in a scratch doc. */
  async function buildSeed(): Promise<ArtifactDocSeed> {
    if (deps.readOnly) {
      unseeded = true;
      throw new CoeditUnavailable('Nobody seeded this doc yet');
    }
    const file = await deps.read();
    return { update: deps.seed(file.text), markdown: file.text, version: file.version ?? '' };
  }

  function onEngineReset() {
    if (ended) return;
    if (loading) {
      resetAgain = true;
      return;
    }
    const reload = () =>
      // A refusal fails the engine (`onStatus('failed')` falls back); falling back again is a no-op.
      void load(false).catch((error: unknown) =>
        fallBack(error instanceof CoeditUnavailable ? 'unseeded' : reasonOf(lastError)),
      );
    if (!deps.readOnly || !deps.seeded) return reload();
    // A read-only viewer keeps showing the doc until an editor seeded it again.
    loading = true;
    const seeded = deps.seeded;
    const ask = () => {
      void seeded().then(
        (yes) => {
          if (ended) return;
          if (!yes) return void clock.set(ask, SEED_POLL_MS);
          loading = false;
          reload();
        },
        () => {
          if (!ended) clock.set(ask, SEED_POLL_MS);
        },
      );
    };
    ask();
  }

  /**
   * Load the doc (`initial`), or load it again after a reset on a fresh
   * `Y.Doc`. A reset during the load loads again, on another fresh doc: the
   * engine may have applied part of the old one.
   */
  async function load(initial: boolean): Promise<void> {
    loading = true;
    try {
      for (let attempt = 0; ; attempt++) {
        resetAgain = false;
        const reuse = initial && attempt === 0;
        const fresh = reuse ? doc : new Y.Doc();
        const unlistenFresh = reuse ? unlisten : listen(fresh);
        target = fresh;
        let loaded: { created: boolean; base: ArtifactDocBase | null };
        try {
          loaded = await sync.start(buildSeed);
        } catch (error) {
          if (!reuse) {
            unlistenFresh();
            fresh.destroy();
          }
          target = doc;
          if (!ended && isDocReset(error)) {
            // Reset again during the load: load again. A reset the engine reports later (a poisoned
            // row waits for its reset on the server) starts its own load through `onReset`.
            if (resetAgain) continue;
            return;
          }
          throw error;
        }
        if (ended) return;
        adopt(fresh, unlistenFresh, loaded, initial);
        return;
      }
    } finally {
      loading = false;
    }
  }

  /** The loaded doc becomes the one the editor binds to; after a reset, the person's text waits to be put back. */
  function adopt(
    fresh: Y.Doc,
    unlistenFresh: () => void,
    loaded: { created: boolean; base: ArtifactDocBase | null },
    initial: boolean,
  ) {
    const rebuilt = loaded.base?.markdown;
    if (fresh !== doc && !bindable(fresh)) {
      // The rebuilt doc holds a node the editor cannot render: no rebind. The editor and its text stay
      // for the fallback (autosave on what the person sees).
      unlistenFresh();
      fresh.destroy();
      target = doc;
      fallBack('failed');
      return;
    }
    if (fresh !== doc) {
      if (!initial && !deps.readOnly) {
        // The editor still shows the old doc: what the person sees now, typing during the load included.
        const mine = readMarkdown();
        // The last text both had: the rebuilt doc's, when this tab passed through it (the last flush);
        // else the file text this tab last took in.
        const base = rebuilt !== undefined && hasPassed(rebuilt) ? rebuilt : mergeBase;
        recovery = mine !== null && mine !== base ? { base, mine } : null;
      }
      if (!initial) {
        try {
          savedView = editor?.saveView?.() ?? null;
        } catch {
          savedView = null;
        }
      }
      unlisten();
      staleDoc = doc;
      doc = fresh;
      target = fresh;
      unlisten = unlistenFresh;
      unrenderableHandlers.set(doc, onUnrenderable);
      editor = null;
      if (initial) {
        staleDoc.destroy();
        staleDoc = null;
      }
    }
    if (loaded.base && rebuilt !== undefined) {
      known = { version: loaded.base.version, text: rebuilt };
      mergeBase = rebuilt;
      remember(id, rebuilt, true);
    }
    if (!initial) deps.onRebind?.();
  }

  // ── The leader ────────────────────────────────────────────────────────────

  /** Local or remote: the leader writes AUTOSAVE_MS after the last change. */
  const changed = () => {
    if (!leader || !editor || ended) return;
    debounce = stop(debounce);
    debounce = clock.set(() => {
      debounce = null;
      want.flush = true;
      void pump();
    }, AUTOSAVE_MS);
  };

  function setLeader(next: boolean) {
    if (ended || next === leader) return;
    leader = next;
    deps.onLeader?.(next);
    if (next) {
      want.takeover = true;
      void pump();
      return;
    }
    // Another tab writes now: drop every pending duty.
    debounce = stop(debounce);
    retry = stop(retry);
    gap = stop(gap);
    want.takeover = want.moved = want.flush = false;
    writeFailing = false;
    report();
    settle();
  }

  /** Resolve the `flushNow` callers once nothing waits to be written (a retry does not count). */
  function settle() {
    const busyNow =
      !ended && leader && !!editor && (want.takeover || want.moved || (want.flush && retry === null));
    if (running || busyNow) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  const pending = () =>
    !ended &&
    leader &&
    !!editor &&
    (want.takeover || want.moved || (want.flush && retry === null && gap === null));

  /** Run the leader's duties one at a time: catch up, a moved file, a write. */
  function pump(): Promise<void> {
    if (running) return running;
    const run = drain().finally(() => {
      if (running === run) running = null;
      if (pending()) void pump();
      else settle();
    });
    running = run;
    return run;
  }

  async function drain() {
    await Promise.resolve();
    while (!ended && leader && editor) {
      if (want.takeover) {
        want.takeover = false;
        await takeOver();
        continue;
      }
      if (want.moved) {
        want.moved = false;
        await moved(movedVersion);
        continue;
      }
      if (want.flush && retry === null) {
        const wait = lastWriteEnd + SAVE_GAP_MS - clock.now();
        if (wait > 0) {
          gap = stop(gap);
          gap = clock.set(() => {
            gap = null;
            void pump();
          }, wait);
          return;
        }
        want.flush = false;
        await flushOnce();
        continue;
      }
      return;
    }
  }

  /** A write or a read failed: try again later, backing off. */
  function failing() {
    failures += 1;
    writeFailing = true;
    want.flush = true;
    retry = stop(retry);
    retry = clock.set(
      () => {
        retry = null;
        void pump();
      },
      Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1)),
    );
    report();
  }

  /**
   * Tell the engine the file holds the doc as `known` (once per flush).
   * `seq`: `covered` when that Markdown was serialized, so the record never
   * claims updates pulled while the write was on its way.
   */
  function record(seq: number) {
    const at = known;
    if (at.version === null || (recorded && recorded.version === at.version && recorded.text === at.text))
      return;
    recorded = at;
    void sync.flushed({ version: at.version, markdown: at.text, seq }).catch(() => {
      // Not the leader any more (`onLeader(false)` follows), or closed: the next leader records its own.
      if (recorded === at) recorded = null;
    });
  }

  async function loadRestores() {
    if (!deps.restores) return;
    try {
      knownRestores = new Set(await deps.restores());
    } catch {
      knownRestores = null;
    }
  }

  /** Activity has a restore event this tab has not met: someone restored a version on purpose. */
  async function newRestore(): Promise<boolean> {
    if (!deps.restores) return false;
    for (let attempt = 0; ; attempt++) {
      let ids: string[];
      try {
        ids = await deps.restores();
      } catch {
        return false;
      }
      if (!knownRestores) {
        // No baseline (the read at takeover failed): from now on there is one.
        knownRestores = new Set(ids);
        return false;
      }
      const fresh = ids.filter((restore) => !knownRestores!.has(restore));
      for (const restore of fresh) knownRestores.add(restore);
      if (fresh.length) return true;
      if (attempt > 0 || ended) return false;
      await sleep(RESTORE_RECHECK_MS);
    }
  }

  /**
   * The file holds `now`, not what this tab wrote (`mine`). Returns what it
   * did: took the version, will write over an older own text (a Files mount
   * heal), or merged another writer's text (or a restore) into the live doc.
   */
  async function reconcile(now: Known, mine: string): Promise<'same' | 'ours' | 'theirs'> {
    const verdict = fileVerdict(id, now.text, mine, mergeBase);
    known = now;
    if (verdict === 'same') {
      mergeBase = now.text;
      heals = 0;
      return verdict;
    }
    if ((verdict === 'ours' || hasPassed(now.text)) && !(await newRestore())) {
      // A Files mount merged an older copy back: our text goes on top. Never merged: that would revert us.
      heals += 1;
      if (heals > MAX_HEALS) failing();
      else want.flush = true;
      return 'ours';
    }
    if (ended || !leader || !editor) return 'theirs';
    editor.merge(mergeBase, now.text);
    mergeBase = now.text;
    remember(id, now.text, true);
    heals = 0;
    want.flush = true;
    return verdict;
  }

  async function takeOver() {
    let file: Known;
    let base: ArtifactDocBase | null;
    try {
      [file, base] = await Promise.all([deps.read(), sync.base(), loadRestores()]);
    } catch {
      want.takeover = true;
      failing();
      return;
    }
    if (ended || !leader || !editor) return;
    const current = readMarkdown();
    if (current === null) {
      want.takeover = true;
      return;
    }
    known = file;
    recorded = base && base.version !== null ? { version: base.version, text: base.markdown } : null;
    const flushed = base?.markdown ?? file.text;
    // The file changed since the last flush (an agent wrote it while nobody had the doc open): merge it
    // in. Unless the doc passed through that text: the last leader wrote it and died before recording.
    if (file.text !== flushed && file.text !== current && !hasPassed(file.text)) editor!.merge(flushed, file.text);
    mergeBase = file.text;
    remember(id, file.text, true);
    // Writes only when the doc holds what the file lacks (the last leader's tail, or the merge).
    want.flush = true;
  }

  async function moved(version: string | null) {
    if (version !== null && version === known.version) return;
    let now: Known;
    try {
      now = await deps.read();
    } catch {
      // The next write's 409 meets the change.
      return;
    }
    if (ended || !leader || !editor || now.version === known.version) return;
    if (now.text === known.text) {
      known = now;
      return;
    }
    await reconcile(now, known.text);
  }

  async function flushOnce() {
    const md = readMarkdown();
    const seq = sync.covered;
    if (md === null) {
      want.flush = true;
      return;
    }
    if (md === known.text) {
      localDirty = false;
      writeFailing = false;
      report();
      record(seq);
      return;
    }
    writing = true;
    localDirty = false;
    remember(id, md);
    try {
      const version = await deps.write(md, known.version);
      known = { version, text: md };
      mergeBase = md;
      notePassed(md);
      heals = 0;
      failures = 0;
      writeFailing = false;
      record(seq);
    } catch (err) {
      if (!deps.isConflict(err)) {
        localDirty = true;
        failing();
      } else {
        const now = await deps.read().catch(() => null);
        if (!now) failing();
        else if (!ended && editor && (await reconcile(now, md)) === 'same') {
          failures = 0;
          writeFailing = false;
          record(seq);
        }
      }
    } finally {
      writing = false;
      lastWriteEnd = clock.now();
      report();
    }
  }

  /** Put the person's text back once every tab before this one in the doc's recovery map is done. */
  function queueRecovery() {
    const into = doc;
    const marks = into.getMap<number>(RECOVERY_KEY);
    marks.set(deps.holder, 0);
    const since = clock.now();
    const check = () => {
      recoveryTimer = null;
      if (ended || doc !== into || !recovery) return;
      const ahead = [...marks.entries()].some(([holder, done]) => holder < deps.holder && done === 0);
      if (!editor || (ahead && clock.now() - since < RECOVERY_WAIT_MS)) {
        recoveryTimer = clock.set(check, RECOVERY_POLL_MS);
        return;
      }
      const back = recovery;
      recovery = null;
      try {
        if (editor.recover) editor.recover(back.base, back.mine);
        else editor.merge(back.base, back.mine);
        if (savedView !== null) editor.restoreView?.(savedView);
      } catch {
        // The editor went away under us: its text stays in the old doc, gone with it.
      }
      savedView = null;
      marks.set(deps.holder, 1);
    };
    recoveryTimer = stop(recoveryTimer);
    recoveryTimer = clock.set(check, RECOVERY_SETTLE_MS);
  }

  /** Send what is unsent, release the lease, stop. Idempotent. */
  function closeSession() {
    if (closed) return;
    closed = true;
    ended = true;
    stopAll();
    unlisten();
    settle();
    void sync.close();
  }

  // ── The surface ───────────────────────────────────────────────────────────

  return {
    /** The live doc: the editor binds to its `COEDIT_FIELD` fragment. A reset replaces it (`onRebind`). */
    get doc() {
      return doc;
    },
    get leader() {
      return leader;
    },
    /** This tab's lease id. */
    holder: deps.holder,
    /** Load (or seed) the doc. Rejects on a refusal, and with `CoeditUnavailable` for a read-only viewer of an unseeded doc. */
    /**
     * Load the doc, seeding it from the file (read fresh) when nobody did.
     * Rejects on a refusal, and with `CoeditUnavailable` for a read-only
     * viewer of an unseeded doc. A reset during the load loads again.
     */
    async start(): Promise<void> {
      await load(true);
      if (ended) return;
      if (!bindable(doc)) {
        // Never mount on it: the host opens the file with autosave (`stoppedFailed`). The engine sent
        // its reset when it met the node (`apply`).
        closeSession();
        throw unrenderable();
      }
      started = true;
    },
    /**
     * The editor is mounted on `doc`: the leader's duties can run. After a
     * reset, the person's text goes back onto the rebuilt doc first. Returns
     * the detach.
     */
    attach(bridge: CoeditEditor): () => void {
      editor = bridge;
      if (staleDoc) {
        staleDoc.destroy();
        staleDoc = null;
      }
      if (savedView !== null) {
        bridge.restoreView?.(savedView);
        // Once the person's text is back, the caret goes after it again.
        if (!recovery) savedView = null;
      }
      if (recovery) queueRecovery();
      sample();
      if (leader) void pump();
      return () => {
        if (editor === bridge) editor = null;
      };
    },
    /** A `changed doc` ping from the live socket. */
    notify(seq: number) {
      if (!ended) sync.notify(seq);
    },
    /** The Artifact says its file moved (`changed content`). Only the leader looks. */
    fileMoved(version: string | null) {
      if (ended || !leader) return;
      if (version !== null && version === known.version) return;
      movedVersion = version;
      want.moved = true;
      void pump();
    },
    /** Write now (⌘S); resolves when nothing waits to be written. A tab that does not lead resolves at once. */
    flushNow(): Promise<void> {
      if (ended || !leader || !editor) return Promise.resolve();
      debounce = stop(debounce);
      want.flush = true;
      void pump();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settle();
      });
    },
    /**
     * The file once it holds the doc's text, for a comment's anchor: the
     * leader writes now; another tab waits for the leader's write (up to
     * `SNAPSHOT_MS`). Rejects when the file does not catch up.
     */
    async snapshot(): Promise<Known> {
      const deadline = clock.now() + SNAPSHOT_MS;
      for (;;) {
        if (ended || !editor) throw new Error('The co-edited doc is closed');
        if (leader) await this.flushNow();
        const md = readMarkdown();
        if (md === null) throw new Error('The co-edited doc is closed');
        if (leader && !writing && known.text === md) return known;
        const file = await deps.read().catch(() => null);
        if (file && file.text === md) return file;
        if (clock.now() + SNAPSHOT_POLL_MS > deadline) throw new Error('The file does not hold the doc yet');
        await sleep(SNAPSHOT_POLL_MS);
      }
    },
    /** Something is not safe yet: updates not on the server, or (leading) this tab's edit not in the file. */
    busy(): boolean {
      if (ended) return false;
      return (
        loading ||
        recovery !== null ||
        engineStatus === 'syncing' ||
        engineStatus === 'retrying' ||
        engineStatus === 'reset' ||
        (leader && (localDirty || writing))
      );
    },
    /** The file as this tab last saw it: the base for autosave after a fallback. */
    known: (): Known => known,
    /** The attached editor's Markdown now; null before `attach`. */
    markdown: (): string | null => readMarkdown(),
    /** Unmount or page hide: send what is unsent, release the lease, stop. Idempotent. */
    close: () => closeSession(),
  };
}

export type DocCoeditSession = ReturnType<typeof createDocCoedit>;

/**
 * A read-only viewer of a doc nobody seeded shows the file; it asks every
 * `SEED_POLL_MS` whether someone seeded the doc, and calls `onSeeded` once
 * when they did. A failed ask is asked again next time. Returns the stop.
 */
export function waitForSeed(input: {
  seeded: () => Promise<boolean>;
  onSeeded: () => void;
  timers?: Timers;
}): () => void {
  const clock = input.timers ?? realTimers;
  let stopped = false;
  let timer: unknown = null;
  const ask = () => {
    timer = clock.set(() => {
      timer = null;
      void input.seeded().then(
        (seeded) => {
          if (stopped) return;
          if (!seeded) return ask();
          stopped = true;
          input.onSeeded();
        },
        () => {
          if (!stopped) ask();
        },
      );
    }, SEED_POLL_MS);
  };
  ask();
  return () => {
    stopped = true;
    if (timer !== null) clock.clear(timer);
  };
}

/** `changed doc` pings from the viewer's live connection to the mounted editor's session. */
export function createDocPings() {
  const listeners = new Set<(seq: number) => void>();
  return {
    emit: (seq: number) => {
      for (const listener of listeners) listener(seq);
    },
    subscribe(listener: (seq: number) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type DocPings = ReturnType<typeof createDocPings>;
