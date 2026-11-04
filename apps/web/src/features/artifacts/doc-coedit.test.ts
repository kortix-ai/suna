import { describe, expect, test } from 'bun:test';
import type {
  ArtifactDocBase,
  ArtifactDocSeed,
  ArtifactDocSync,
  ArtifactDocSyncOptions,
  ArtifactDocSyncStatus,
} from '@kortix/sdk';
import * as Y from 'yjs';

import type { DocSaveStatus, Known, Timers } from './doc-autosave';
import {
  COEDIT_FIELD,
  RECOVERY_KEY,
  RECOVERY_SETTLE_MS,
  REMOTE_ORIGIN,
  SNAPSHOT_MS,
  createDocCoedit,
  waitForSeed,
  SEED_POLL_MS,
  type CoeditEditor,
  type CoeditFallback,
  type DocCoeditDeps,
} from './doc-coedit';

/** A fake clock: timers run only when the test moves time (as doc-autosave.test.ts). */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const timers: Timers = {
    now: () => now,
    set: (fn, ms) => {
      due.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clear: (id) => void due.delete(id as number),
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await settle();
    for (;;) {
      const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      due.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await settle();
    }
    now = end;
    await settle();
  };
  return { timers, advance, settle, now: () => now };
}

/** The engine (WP3) as the orchestration sees it: every call recorded, every callback driven by the test. */
function fakeSync(input: { seeded?: boolean; base?: ArtifactDocBase | null } = {}) {
  let options!: ArtifactDocSyncOptions;
  const state = {
    seeded: input.seeded ?? true,
    base: input.base === undefined ? ({ markdown: 'A\n', version: 'v1', seq: 1 } as ArtifactDocBase | null) : input.base,
    stored: [] as Uint8Array[],
    seeds: [] as Array<{ seed: ArtifactDocSeed; restart: boolean }>,
    pushed: [] as Uint8Array[],
    notified: [] as number[],
    flushes: [] as Array<{ version: string; markdown: string; seq?: number }>,
    /** What `covered` answers: the test moves it. */
    covered: 0,
    starts: 0,
    closed: false,
    status: 'connecting' as ArtifactDocSyncStatus,
    leader: false,
    /** While set, `start` waits for it (a reset can land during the restart). */
    startGate: null as Promise<void> | null,
    rejectStart: null as ((error: unknown) => void) | null,
  };
  const engine: ArtifactDocSync = {
    get status() {
      return state.status;
    },
    get leader() {
      return state.leader;
    },
    get covered() {
      return state.covered;
    },
    start(buildSeed) {
      const restart = state.starts > 0;
      state.starts += 1;
      state.status = 'connecting';
      return new Promise((resolve, reject) => {
        // A reset while this load runs rejects it with `doc_reset`, as the engine does.
        state.rejectStart = reject;
        void (async () => {
          if (state.startGate) await state.startGate;
          if (!state.seeded) {
            const seed = await buildSeed({ restart });
            state.seeds.push({ seed, restart });
            options.apply(seed.update);
            state.seeded = true;
            return { created: true, base: { markdown: seed.markdown, version: seed.version, seq: 1 } };
          }
          for (const update of state.stored) options.apply(update);
          return { created: false, base: state.base };
        })().then(resolve, reject);
      });
    },
    push: (update) => void state.pushed.push(update),
    notify: (seq) => void state.notified.push(seq),
    async flushed(flush) {
      state.flushes.push(flush);
      state.base = { markdown: flush.markdown, version: flush.version, seq: 1 };
      return { seq: 1, flushed_seq: 1 };
    },
    base: async () => state.base,
    async close() {
      state.closed = true;
    },
  };
  return {
    state,
    create: (opts: ArtifactDocSyncOptions) => {
      options = opts;
      return engine;
    },
    options: () => options,
    /** What the engine does on a reset (v2): status `reset`, `onLeader(false)`, then `onReset`. */
    reset(reason: 'not_seeded' | 'epoch' | 'poisoned', next: { seeded: boolean; base?: ArtifactDocBase | null; stored?: Uint8Array[] }) {
      state.seeded = next.seeded;
      if (next.base !== undefined) state.base = next.base;
      state.stored = next.stored ?? [];
      state.status = 'reset';
      state.rejectStart?.(Object.assign(new Error('The co-edited doc was reset'), { code: 'doc_reset' }));
      options.onStatus?.('reset');
      if (state.leader) {
        state.leader = false;
        options.onLeader?.(false);
      }
      options.onReset?.({ reason });
    },
    lead(leader = true) {
      state.leader = leader;
      options.onLeader?.(leader);
    },
    status(status: ArtifactDocSyncStatus) {
      state.status = status;
      options.onStatus?.(status);
    },
    /** A pulled update from another tab. */
    remote(text: string) {
      const other = new Y.Doc();
      other.getText('other').insert(0, text);
      options.apply(Y.encodeStateAsUpdate(other));
    },
  };
}

class Conflict extends Error {
  status = 409;
  code = 'version_conflict';
}

/** The Markdown file in Files: a version per write, If-Match on the base. */
function fakeFile(text: string) {
  let n = 1;
  const file = {
    text,
    version: 'v1',
    writes: [] as Array<{ text: string; base: string | null }>,
    reads: 0,
    /** Before the next write lands, another writer (or the mount) puts this in the file. */
    raceOnWrite: null as string | null,
    /** Another writer, or the mount's merge: a new version, any text. */
    external(next: string) {
      file.text = next;
      file.version = `v${++n}`;
    },
    async write(next: string, base: string | null) {
      file.writes.push({ text: next, base });
      if (file.raceOnWrite !== null) {
        file.external(file.raceOnWrite);
        file.raceOnWrite = null;
      }
      if (base !== file.version) throw new Conflict('version_conflict');
      file.external(next);
      return file.version;
    },
    async read(): Promise<Known> {
      file.reads += 1;
      return { version: file.version, text: file.text };
    },
  };
  return file;
}

/** The editor as the orchestration sees it: its Markdown, and the outside-edit merge (WP5). */
function fakeEditor(markdown: string) {
  const editor = {
    markdown,
    merges: [] as Array<{ base: string; theirs: string }>,
    /** The reset recoveries: the person's text put onto the rebuilt doc. */
    recovers: [] as Array<{ base: string; mine: string }>,
    /** What the doc holds after a merge; default: theirs plus the person's own last line. */
    mergeResult: null as string | null,
  };
  const bridge: CoeditEditor = {
    markdown: () => editor.markdown,
    merge(base, theirs) {
      editor.merges.push({ base, theirs });
      editor.markdown = editor.mergeResult ?? theirs;
      return { changed: true, conflicts: 0 };
    },
    recover(base, mine) {
      editor.recovers.push({ base, mine });
      editor.markdown = mine;
      return { changed: true, conflicts: 0 };
    },
  };
  return { editor, bridge };
}

let tabs = 0;
function setup(
  options: {
    text?: string;
    readOnly?: boolean;
    seeded?: boolean;
    base?: ArtifactDocBase | null;
  } = {},
) {
  const clock = fakeClock();
  const text = options.text ?? 'A\n';
  const file = fakeFile(text);
  const sync = fakeSync({ seeded: options.seeded, base: options.base });
  const statuses: DocSaveStatus[] = [];
  const fallbacks: CoeditFallback[] = [];
  let rebinds = 0;
  const seededFrom: string[] = [];
  /** Activity's `restored` events, newest first: a deliberate restore adds one. */
  const restores: string[] = [];
  const artifactId = `artifact-${++tabs}`;
  const deps: DocCoeditDeps = {
    projectId: 'project',
    artifactId,
    holder: `tab-${tabs}`,
    readOnly: options.readOnly ?? false,
    opened: { version: 'v1', text },
    seed: (markdown) => {
      seededFrom.push(markdown);
      const scratch = new Y.Doc();
      // One element, as the editor seeds: a text node at the root is a doc no editor can render.
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(markdown)]);
      scratch.getXmlFragment(COEDIT_FIELD).insert(0, [paragraph]);
      return Y.encodeStateAsUpdate(scratch);
    },
    write: (next, base) => file.write(next, base),
    read: () => file.read(),
    isConflict: (err) => err instanceof Conflict,
    restores: async () => [...restores],
    onStatus: (status) => statuses.push(status),
    onFallback: (reason) => fallbacks.push(reason),
    onRebind: () => {
      rebinds += 1;
    },
    timers: clock.timers,
    createSync: sync.create,
  };
  const session = createDocCoedit(deps);
  const { editor, bridge } = fakeEditor(text);
  /** The person types: the live doc changes (a local Yjs update) and so does its Markdown. */
  const type = (markdown: string) => {
    editor.markdown = markdown;
    session.doc.getText('typed').insert(0, 'x');
  };
  /** Someone restores an older version from Activity: the file holds it, and Activity has a new `restored` event. */
  const restore = (text: string) => {
    restores.unshift(`event:restore-${restores.length + 1}`);
    tab.file.external(text);
  };
  const tab = {
    clock, file, sync, session, editor, bridge, statuses, fallbacks, seededFrom, type, artifactId, restores, restore,
    rebinds: () => rebinds,
    deps,
  };
  return tab;
}

/** Started, editor attached, holding the lease. */
async function leading(options: Parameters<typeof setup>[0] = {}) {
  const tab = setup(options);
  await tab.session.start();
  tab.session.attach(tab.bridge);
  tab.sync.lead();
  await tab.clock.settle();
  return tab;
}

describe('starting', () => {
  test('an unseeded doc is seeded from the opened file, through the editor load path', async () => {
    const tab = setup({ seeded: false, text: '# Plan\n' });
    await tab.session.start();
    expect(tab.seededFrom).toEqual(['# Plan\n']);
    expect(tab.sync.state.seeds).toHaveLength(1);
    expect(tab.sync.state.seeds[0].seed.markdown).toBe('# Plan\n');
    expect(tab.sync.state.seeds[0].seed.version).toBe('v1');
    // The engine applies the seed only after the server took it: the live doc holds it now.
    expect(tab.session.doc.getXmlFragment(COEDIT_FIELD).toString()).toBe('<paragraph># Plan\n</paragraph>');
    // The seed is not pushed back: it came through the engine.
    expect(tab.sync.state.pushed).toHaveLength(0);
  });

  test('a read-only viewer never seeds: start rejects on a doc nobody seeded', async () => {
    const tab = setup({ seeded: false, readOnly: true });
    await expect(tab.session.start()).rejects.toThrow();
    expect(tab.seededFrom).toHaveLength(0);
  });
});

describe('pushing', () => {
  test("local updates are pushed; updates the engine pulled are not", async () => {
    const tab = setup();
    await tab.session.start();
    tab.type('A b\n');
    expect(tab.sync.state.pushed).toHaveLength(1);
    tab.sync.remote('from another tab');
    expect(tab.sync.state.pushed).toHaveLength(1);
    expect(tab.session.doc.getText('other').toString()).toBe('from another tab');
  });

  test('a read-only viewer never pushes', async () => {
    const tab = setup({ readOnly: true });
    await tab.session.start();
    tab.type('A b\n');
    expect(tab.sync.state.pushed).toHaveLength(0);
  });

  test("a changed doc ping reaches the engine", async () => {
    const tab = setup();
    await tab.session.start();
    tab.session.notify(7);
    expect(tab.sync.state.notified).toEqual([7]);
  });
});

describe('the leader writes the file', () => {
  test('2 s after the last change, with base_version, then records the flush', async () => {
    const tab = await leading();
    tab.type('A b\n');
    await tab.clock.advance(1_500);
    tab.type('A b c\n');
    await tab.clock.advance(1_999);
    expect(tab.file.writes).toHaveLength(0);
    await tab.clock.advance(1);
    expect(tab.file.writes).toEqual([{ text: 'A b c\n', base: 'v1' }]);
    expect(tab.sync.state.flushes).toEqual([{ version: 'v2', markdown: 'A b c\n', seq: 0 }]);
    expect(tab.session.known()).toEqual({ version: 'v2', text: 'A b c\n' });
  });

  test("another tab's change starts the same 2 s flush", async () => {
    const tab = await leading();
    tab.editor.markdown = 'A from B\n';
    tab.sync.remote('B typed');
    await tab.clock.advance(1_999);
    expect(tab.file.writes).toHaveLength(0);
    await tab.clock.advance(1);
    expect(tab.file.writes).toEqual([{ text: 'A from B\n', base: 'v1' }]);
  });

  test('the next write waits for the one in flight and names its version', async () => {
    const tab = await leading();
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    await tab.clock.advance(2_000);
    expect(tab.file.writes).toEqual([
      { text: 'A 1\n', base: 'v1' },
      { text: 'A 2\n', base: 'v2' },
    ]);
  });

  test('⌘S writes now', async () => {
    const tab = await leading();
    tab.type('A now\n');
    await tab.session.flushNow();
    expect(tab.file.writes).toEqual([{ text: 'A now\n', base: 'v1' }]);
  });

  test('a tab that does not lead never writes, and ignores a moved file', async () => {
    const tab = setup();
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.type('A b\n');
    await tab.clock.advance(10_000);
    tab.file.external('B\n');
    tab.session.fileMoved(tab.file.version);
    await tab.clock.advance(10_000);
    expect(tab.file.writes).toHaveLength(0);
    expect(tab.file.reads).toBe(0);
    expect(tab.editor.merges).toHaveLength(0);
  });

  test('losing the lease stops the pending write', async () => {
    const tab = await leading();
    tab.type('A b\n');
    tab.sync.lead(false);
    await tab.clock.advance(5_000);
    expect(tab.file.writes).toHaveLength(0);
  });
});

describe('a 409 on the leader write (doc-autosave rules)', () => {
  test('the same text under a new version: take the version, write nothing more', async () => {
    const tab = await leading();
    tab.type('A b\n');
    tab.file.raceOnWrite = 'A b\n';
    await tab.clock.advance(2_000);
    expect(tab.file.writes).toHaveLength(1);
    expect(tab.session.known()).toEqual({ version: tab.file.version, text: 'A b\n' });
    expect(tab.sync.state.flushes).toEqual([{ version: tab.file.version, markdown: 'A b\n', seq: 0 }]);
    expect(tab.editor.merges).toHaveLength(0);
  });

  test('an older text of this tab came back: write ours over it', async () => {
    const tab = await leading();
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    // The Files mount merges the opened text back over the first write. No restore event: a heal,
    // written over after one more look at Activity (1 s).
    tab.file.raceOnWrite = 'A\n';
    await tab.clock.advance(2_000);
    await tab.clock.advance(4_000);
    expect(tab.editor.merges).toHaveLength(0);
    expect(tab.file.text).toBe('A 2\n');
    expect(tab.file.writes.at(-1)).toEqual({ text: 'A 2\n', base: 'v3' });
  });

  test("another writer's text: merge last-flushed → theirs into the live doc, then write the merge", async () => {
    const tab = await leading();
    tab.type('A typed\n');
    tab.file.raceOnWrite = 'A\n\nAgent line\n';
    tab.editor.mergeResult = 'A typed\n\nAgent line\n';
    await tab.clock.advance(2_000);
    await tab.clock.advance(2_000);
    expect(tab.editor.merges).toEqual([{ base: 'A\n', theirs: 'A\n\nAgent line\n' }]);
    expect(tab.file.text).toBe('A typed\n\nAgent line\n');
    expect(tab.sync.state.flushes.at(-1)).toMatchObject({ version: tab.file.version, markdown: 'A typed\n\nAgent line\n' });
  });
});

describe('contract v2: the flush record, the size cap, and a reset', () => {
  test('flushed carries the covered seq captured when the written Markdown was serialized', async () => {
    const tab = await leading();
    tab.sync.state.covered = 4;
    tab.type('A b\n');
    const write = tab.file.write;
    tab.file.write = async (text, base) => {
      // Pulls land while the write is on its way.
      tab.sync.state.covered = 9;
      return write(text, base);
    };
    await tab.clock.advance(2_000);
    expect(tab.sync.state.flushes).toEqual([{ version: 'v2', markdown: 'A b\n', seq: 4 }]);
  });

  test('413 doc_too_large ends co-editing as history-too-large', async () => {
    const tab = await leading();
    tab.sync.options().onError?.(Object.assign(new Error('too large'), { status: 413, code: 'doc_too_large' }));
    tab.sync.status('failed');
    expect(tab.fallbacks).toEqual(['history-too-large']);
  });

  test('a reset rebuilds a fresh Y.Doc, seeds it from the file read fresh, and lands the unsynced text once', async () => {
    const tab = await leading();
    tab.type('A typed\n');
    const before = tab.session.doc;
    const reads = tab.file.reads;
    tab.file.external('A agent\n');
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    expect(tab.sync.state.starts).toBe(2);
    expect(tab.file.reads).toBeGreaterThan(reads);
    expect(tab.sync.state.seeds.at(-1)?.seed).toMatchObject({ markdown: 'A agent\n', version: tab.file.version });
    expect(tab.session.doc).not.toBe(before);
    expect(tab.rebinds()).toBe(1);
    // The host binds a new editor to the fresh doc; it shows the seed.
    const next = fakeEditor('A agent\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS);
    expect(next.editor.recovers).toEqual([{ base: 'A\n', mine: 'A typed\n' }]);
    // The old doc is gone: an edit there is never pushed.
    const pushed = tab.sync.state.pushed.length;
    before.getText('late').insert(0, 'x');
    expect(tab.sync.state.pushed).toHaveLength(pushed);
  });

  test('the base is the rebuilt doc\'s text when this tab passed through it (the last flush)', async () => {
    const tab = await leading();
    tab.type('A one\n');
    await tab.clock.advance(2_000);
    tab.type('A one two\n');
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    const next = fakeEditor('A one\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS);
    expect(next.editor.recovers).toEqual([{ base: 'A one\n', mine: 'A one two\n' }]);
  });

  test('another tab won the seed: the doc is pulled, not seeded, and the text still lands', async () => {
    const tab = await leading();
    tab.type('A mine\n');
    tab.sync.reset('epoch', { seeded: true, base: { markdown: 'A\n', version: 'v1', seq: 1 } });
    await tab.clock.advance(0);
    expect(tab.sync.state.seeds).toHaveLength(0);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS);
    expect(next.editor.recovers).toEqual([{ base: 'A\n', mine: 'A mine\n' }]);
  });

  test('nothing typed since the base: no recovery merge', async () => {
    const tab = await leading();
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS);
    expect(next.editor.recovers).toHaveLength(0);
  });

  test('a read-only viewer rebuilds and merges nothing', async () => {
    const tab = setup({ readOnly: true });
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.editor.markdown = 'A from others\n';
    tab.sync.reset('poisoned', { seeded: true, base: { markdown: 'A\n', version: 'v1', seq: 1 } });
    await tab.clock.advance(0);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    expect(tab.rebinds()).toBe(1);
    expect(next.editor.recovers).toHaveLength(0);
  });

  test('a read-only viewer after a reset nobody seeded again falls back to waiting for the seed', async () => {
    const tab = setup({ readOnly: true });
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    expect(tab.fallbacks).toEqual(['unseeded']);
  });

  test('a read-only viewer that can ask keeps its editor and loads again once an editor seeded the doc', async () => {
    const tab = setup({ readOnly: true });
    let seeded = false;
    tab.session.close();
    const session = createDocCoedit({ ...tab.deps, seeded: async () => seeded });
    await session.start();
    session.attach(tab.bridge);
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(SEED_POLL_MS * 2);
    expect(tab.sync.state.starts).toBe(1);
    expect(tab.fallbacks).toHaveLength(0);
    seeded = true;
    tab.sync.state.seeded = true;
    await tab.clock.advance(SEED_POLL_MS);
    expect(tab.sync.state.starts).toBe(2);
    expect(tab.rebinds()).toBe(1);
  });

  test('tabs recover one at a time: one with a lower holder id that is not done yet goes first', async () => {
    const tab = await leading();
    tab.type('A typed\n');
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    // Another tab reset with this one and marked itself first.
    tab.session.doc.getMap<number>(RECOVERY_KEY).set('tab-0', 0);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS + 1_000);
    expect(next.editor.recovers).toHaveLength(0);
    tab.session.doc.getMap<number>(RECOVERY_KEY).set('tab-0', 1);
    await tab.clock.advance(250);
    expect(next.editor.recovers).toEqual([{ base: 'A\n', mine: 'A typed\n' }]);
    expect(tab.session.doc.getMap<number>(RECOVERY_KEY).get(tab.session.holder)).toBe(1);
  });

  test('a tab before this one that never finishes holds it up 5 s at most', async () => {
    const tab = await leading();
    tab.type('A typed\n');
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    tab.session.doc.getMap<number>(RECOVERY_KEY).set('tab-0', 0);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(4_500);
    expect(next.editor.recovers).toHaveLength(0);
    await tab.clock.advance(1_000);
    expect(next.editor.recovers).toHaveLength(1);
  });

  test('a second reset during the restart starts again', async () => {
    const tab = await leading();
    tab.type('A typed\n');
    let open!: () => void;
    tab.sync.state.startGate = new Promise<void>((resolve) => (open = resolve));
    tab.sync.reset('not_seeded', { seeded: false });
    await tab.clock.advance(0);
    // The restart is still loading when the doc is reset again.
    const rejectRestart = tab.sync.state.startGate;
    tab.sync.state.startGate = null;
    tab.sync.reset('epoch', { seeded: false });
    open();
    await rejectRestart;
    await tab.clock.advance(0);
    expect(tab.sync.state.starts).toBeGreaterThanOrEqual(3);
    const next = fakeEditor('A\n');
    tab.session.attach(next.bridge);
    await tab.clock.advance(RECOVERY_SETTLE_MS);
    expect(next.editor.recovers).toEqual([{ base: 'A\n', mine: 'A typed\n' }]);
  });
});

describe('a restore wins (Activity records it; a Files mount heal does not)', () => {
  test('a restore to an older text of this tab is merged into the live doc, never written over', async () => {
    const tab = await leading();
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    await tab.clock.advance(2_000);
    tab.restore('A 1\n');
    tab.session.fileMoved(tab.file.version);
    await tab.clock.advance(0);
    expect(tab.editor.merges).toEqual([{ base: 'A 2\n', theirs: 'A 1\n' }]);
    await tab.clock.advance(10_000);
    expect(tab.file.text).toBe('A 1\n');
    expect(tab.file.writes).toHaveLength(2);
    expect(tab.session.known()).toEqual({ version: tab.file.version, text: 'A 1\n' });
  });

  test("a restore met by the leader's write (409) wins too", async () => {
    const tab = await leading();
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    tab.restores.unshift('event:restore-x');
    tab.file.raceOnWrite = 'A\n';
    await tab.clock.advance(2_000);
    await tab.clock.advance(5_000);
    expect(tab.editor.merges).toEqual([{ base: 'A 1\n', theirs: 'A\n' }]);
    expect(tab.file.text).toBe('A\n');
  });

  test('the same older text without a new restore event is a Files mount heal: written over after one re-check', async () => {
    const tab = await leading();
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    tab.file.raceOnWrite = 'A\n';
    await tab.clock.advance(2_000);
    await tab.clock.advance(5_000);
    expect(tab.editor.merges).toHaveLength(0);
    expect(tab.file.text).toBe('A 2\n');
  });

  test('a restore Activity already held when this tab took the lease is not a new one', async () => {
    const tab = setup();
    tab.restores.push('event:restore-old');
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.sync.lead();
    await tab.clock.advance(0);
    tab.type('A 1\n');
    await tab.clock.advance(2_000);
    tab.type('A 2\n');
    tab.file.raceOnWrite = 'A 1\n';
    await tab.clock.advance(2_000);
    await tab.clock.advance(5_000);
    expect(tab.editor.merges).toHaveLength(0);
    expect(tab.file.text).toBe('A 2\n');
  });
});

describe('a read-only viewer waits for the seed', () => {
  test(`asks every ${SEED_POLL_MS / 1000} s until someone seeds the doc, then switches once`, async () => {
    const clock = fakeClock();
    let seeded = false;
    let asks = 0;
    let switched = 0;
    const stop = waitForSeed({
      seeded: async () => {
        asks += 1;
        if (asks === 2) throw new Error('offline');
        return seeded;
      },
      onSeeded: () => {
        switched += 1;
      },
      timers: clock.timers,
    });
    await clock.advance(SEED_POLL_MS * 3);
    expect(asks).toBe(3);
    expect(switched).toBe(0);
    seeded = true;
    await clock.advance(SEED_POLL_MS);
    expect(switched).toBe(1);
    await clock.advance(SEED_POLL_MS * 5);
    expect(asks).toBe(4);
    stop();
  });

  test('stop ends the asking', async () => {
    const clock = fakeClock();
    let asks = 0;
    const stop = waitForSeed({ seeded: async () => (asks += 1) > 100, onSeeded: () => {}, timers: clock.timers });
    await clock.advance(SEED_POLL_MS);
    stop();
    await clock.advance(SEED_POLL_MS * 5);
    expect(asks).toBe(1);
  });
});

describe('a moved file (changed content) while leading', () => {
  test('an outside edit is merged at once, then written', async () => {
    const tab = await leading();
    tab.file.external('A\n\nAgent line\n');
    tab.session.fileMoved(tab.file.version);
    await tab.clock.settle();
    expect(tab.editor.merges).toEqual([{ base: 'A\n', theirs: 'A\n\nAgent line\n' }]);
    // The merge equals the file: nothing to write.
    await tab.clock.advance(5_000);
    expect(tab.file.writes).toHaveLength(0);
    expect(tab.session.known()).toEqual({ version: 'v2', text: 'A\n\nAgent line\n' });
  });

  test('the same text under a new version only takes the version', async () => {
    const tab = await leading();
    tab.file.external('A\n');
    tab.session.fileMoved(tab.file.version);
    await tab.clock.settle();
    expect(tab.editor.merges).toHaveLength(0);
    tab.type('A b\n');
    await tab.clock.advance(2_000);
    expect(tab.file.writes).toEqual([{ text: 'A b\n', base: 'v2' }]);
  });

  test("the leader's own write moves the file: nothing to read", async () => {
    const tab = await leading();
    tab.type('A b\n');
    await tab.clock.advance(2_000);
    const reads = tab.file.reads;
    tab.session.fileMoved('v2');
    await tab.clock.settle();
    expect(tab.file.reads).toBe(reads);
  });
});

describe('taking the lease', () => {
  test('the file changed since the last flush: merge it into the live doc, then write', async () => {
    const tab = setup({ base: { markdown: 'A\n', version: 'v1', seq: 3 } });
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.type('A typed\n');
    tab.file.external('A\n\nAgent line\n');
    tab.editor.mergeResult = 'A typed\n\nAgent line\n';
    tab.sync.lead();
    await tab.clock.advance(0);
    expect(tab.editor.merges).toEqual([{ base: 'A\n', theirs: 'A\n\nAgent line\n' }]);
    await tab.clock.advance(2_000);
    expect(tab.file.writes).toEqual([{ text: 'A typed\n\nAgent line\n', base: 'v2' }]);
  });

  test('the doc holds a tail the file lacks (the last leader left early): write it without waiting', async () => {
    const tab = setup({ base: { markdown: 'A\n', version: 'v1', seq: 3 } });
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.editor.markdown = 'A and the tail\n';
    tab.sync.lead();
    await tab.clock.advance(0);
    expect(tab.editor.merges).toHaveLength(0);
    expect(tab.file.writes).toEqual([{ text: 'A and the tail\n', base: 'v1' }]);
  });

  test('the lease before the editor: the duties start when it attaches', async () => {
    const tab = setup();
    await tab.session.start();
    tab.sync.lead();
    tab.editor.markdown = 'A tail\n';
    await tab.clock.advance(5_000);
    expect(tab.file.writes).toHaveLength(0);
    tab.session.attach(tab.bridge);
    await tab.clock.advance(0);
    expect(tab.file.writes).toEqual([{ text: 'A tail\n', base: 'v1' }]);
  });
});

describe('falling back to autosave', () => {
  test('a 413 ends co-editing as too-large', async () => {
    const tab = await leading();
    tab.sync.options().onError?.(Object.assign(new Error('too large'), { status: 413, code: 'update_too_large' }));
    tab.sync.status('failed');
    expect(tab.fallbacks).toEqual(['too-large']);
  });

  test('any other final failure ends it as failed, once', async () => {
    const tab = await leading();
    tab.sync.options().onError?.(Object.assign(new Error('gone'), { status: 404 }));
    tab.sync.status('failed');
    tab.sync.status('failed');
    expect(tab.fallbacks).toEqual(['failed']);
  });

  test('after a fallback the session never writes again', async () => {
    const tab = await leading();
    tab.type('A b\n');
    tab.sync.status('failed');
    await tab.clock.advance(10_000);
    expect(tab.file.writes).toHaveLength(0);
  });
});

describe('status, busy, close', () => {
  test('saved when synced; saving only past 1 s of syncing; error while retrying', async () => {
    const tab = setup();
    await tab.session.start();
    tab.sync.status('synced');
    tab.sync.status('syncing');
    await tab.clock.advance(999);
    tab.sync.status('synced');
    tab.sync.status('syncing');
    await tab.clock.advance(1_000);
    tab.sync.status('retrying');
    tab.sync.status('synced');
    expect(tab.statuses).toEqual(['saved', 'saving', 'error', 'saved']);
  });

  test("busy: the leader's own edit is not in the file yet, or updates are not on the server", async () => {
    const tab = await leading();
    tab.sync.status('synced');
    expect(tab.session.busy()).toBe(false);
    tab.type('A b\n');
    expect(tab.session.busy()).toBe(true);
    await tab.clock.advance(2_000);
    expect(tab.session.busy()).toBe(false);
    tab.sync.status('retrying');
    expect(tab.session.busy()).toBe(true);
  });

  test('close closes the engine, and nothing writes after it', async () => {
    const tab = await leading();
    tab.type('A b\n');
    tab.session.close();
    await tab.clock.advance(10_000);
    expect(tab.sync.state.closed).toBe(true);
    expect(tab.file.writes).toHaveLength(0);
  });
});

describe('a snapshot for a comment', () => {
  test('the leader writes now and answers the file it wrote', async () => {
    const tab = await leading();
    tab.type('A b\n');
    const snapshot = await tab.session.snapshot();
    expect(snapshot).toEqual({ version: 'v2', text: 'A b\n' });
  });

  test('another tab waits for the leader to write the doc into the file', async () => {
    const tab = setup();
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.editor.markdown = 'A b\n';
    const done = tab.session.snapshot();
    await tab.clock.advance(1_000);
    tab.file.external('A b\n');
    await tab.clock.advance(1_000);
    expect(await done).toEqual({ version: tab.file.version, text: 'A b\n' });
  });

  test(`gives up after ${SNAPSHOT_MS / 1000} s`, async () => {
    const tab = setup();
    await tab.session.start();
    tab.session.attach(tab.bridge);
    tab.editor.markdown = 'A b\n';
    const done = tab.session.snapshot().then(
      () => 'resolved',
      () => 'rejected',
    );
    await tab.clock.advance(SNAPSHOT_MS + 1_000);
    expect(await done).toBe('rejected');
  });
});

void REMOTE_ORIGIN;
