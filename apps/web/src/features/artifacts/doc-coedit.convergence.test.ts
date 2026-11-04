/**
 * Live co-editing end to end in one process (KRTX-3670, WP4): real tiptap
 * editors with the doc schema, each on its own `Y.Doc`, the real sync engine
 * (`createArtifactDocSync`), and the orchestration (`doc-coedit.ts`), over a
 * fake doc server that stores and relays updates, holds the lease and pings
 * every tab, plus a fake Markdown file with versions. One fake clock drives
 * all of it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createArtifactDocSync, type ArtifactDocSyncClient } from '@kortix/sdk';
import { Editor } from '@tiptap/core';
import { Window } from 'happy-dom';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import * as Y from 'yjs';

import type { Known, Timers } from './doc-autosave';
import { COEDIT_FIELD, createDocCoedit, type DocCoeditSession } from './doc-coedit';
import { liveBridge, liveExtensions, seedUpdate } from './doc-coedit-editor';

// TipTap parses and prints HTML with the browser DOM (as doc-round-trip.test.ts).
const DOM_GLOBALS = ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element', 'navigator'] as const;
const saved: Record<string, unknown> = {};
const editors: Editor[] = [];
beforeAll(() => {
  const win = new Window();
  for (const key of DOM_GLOBALS) {
    saved[key] = (globalThis as Record<string, unknown>)[key];
    (globalThis as Record<string, unknown>)[key] = key === 'window' ? win : (win as unknown as Record<string, unknown>)[key];
  }
});
afterAll(() => {
  for (const editor of editors) if (!editor.isDestroyed) editor.destroy();
  for (const key of DOM_GLOBALS) (globalThis as Record<string, unknown>)[key] = saved[key];
});

function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
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
  return { timers, advance, now: () => now };
}

type Clock = ReturnType<typeof fakeClock>;
const LEASE_MS = 15_000;
const refusal = (status: number, code: string) => Object.assign(new Error(code), { status, code });

/**
 * The doc routes (WP2, contract v2) in memory: seq per update, the epoch of
 * each seed, the lease, the flush record, a ping per append, `reset`, and the
 * GC (which deletes the state without a ping).
 */
function fakeServer(clock: Clock) {
  let epochs = 0;
  const state = {
    seeded: false,
    epoch: null as string | null,
    rows: [] as Array<{ seq: number; update: Uint8Array }>,
    next: 1,
    flushed: null as { seq: number; version: string; markdown: string } | null,
    lease: null as { holder: string; expires: number } | null,
    pings: new Set<(seq: number) => void>(),
    flushes: [] as Array<{ holder: string; seq: number; version: string; markdown: string }>,
  };
  const leaseNow = () => (state.lease && state.lease.expires > clock.now() ? state.lease : null);
  /** Delete the doc state and every row (a reset, or the GC). */
  const wipe = () => {
    state.seeded = false;
    state.epoch = null;
    state.rows = [];
    state.next = 1;
    state.flushed = null;
    state.lease = null;
  };
  const append = (update: Uint8Array) => {
    const seq = state.next++;
    state.rows.push({ seq, update });
    for (const ping of state.pings) queueMicrotask(() => ping(seq));
    return seq;
  };
  /** The client one tab uses; `cut` makes it fail like a dead network, `dropFlush` loses its next flush record. */
  const client = (tab: { cut: boolean; dropFlush: boolean }): ArtifactDocSyncClient => {
    const guard = () => {
      if (tab.cut) throw refusal(503, 'offline');
    };
    return {
      get: async (_p, _a, options = {}) => {
        guard();
        const after = options.after ?? 0;
        return {
          seeded: state.seeded,
          epoch: state.seeded ? state.epoch : null,
          latest_seq: state.next - 1,
          updates: state.seeded ? state.rows.filter((row) => row.seq > after) : [],
          has_more: false,
          flushed: state.flushed
            ? { seq: state.flushed.seq, version: state.flushed.version, ...(options.base ? { markdown: state.flushed.markdown } : {}) }
            : null,
          lease: leaseNow() ? { holder: leaseNow()!.holder, expires_at: new Date(leaseNow()!.expires).toISOString() } : null,
        };
      },
      seed: async (_p, _a, seed) => {
        guard();
        if (state.seeded) throw refusal(409, 'doc_seeded');
        state.seeded = true;
        state.epoch = `epoch-${++epochs}`;
        const seq = append(seed.update);
        state.flushed = { seq, version: seed.version, markdown: seed.markdown };
        return { seq, epoch: state.epoch };
      },
      push: async (_p, _a, update) => {
        guard();
        if (!state.seeded) throw refusal(409, 'doc_not_seeded');
        return { seq: append(update) };
      },
      lease: async (_p, _a, input) => {
        guard();
        // As the server: no lease before the seed or after a reset.
        if (!state.seeded) throw refusal(409, 'doc_not_seeded');
        const held = leaseNow();
        if (input.release) {
          if (held?.holder === input.holder) state.lease = null;
          return { leader: false, holder: null, expires_at: null };
        }
        if (!held || held.holder === input.holder) state.lease = { holder: input.holder, expires: clock.now() + LEASE_MS };
        const now = leaseNow()!;
        return { leader: now.holder === input.holder, holder: now.holder, expires_at: new Date(now.expires).toISOString() };
      },
      reset: async (_p, _a, input) => {
        guard();
        const held = leaseNow();
        if (held && held.holder !== input.holder) throw refusal(409, 'not_leader');
        wipe();
        for (const ping of state.pings) queueMicrotask(() => ping(0));
      },
      flushed: async (_p, _a, flush) => {
        guard();
        if (tab.dropFlush) {
          tab.dropFlush = false;
          throw refusal(503, 'lost');
        }
        if (leaseNow()?.holder !== flush.holder) throw refusal(409, 'not_leader');
        if (flush.seq > state.next - 1) throw refusal(400, 'invalid_seq');
        state.flushes.push(flush);
        if (!state.flushed || flush.seq >= state.flushed.seq) state.flushed = { seq: flush.seq, version: flush.version, markdown: flush.markdown };
        return { flushed_seq: state.flushed.seq };
      },
    };
  };
  return {
    state,
    client,
    /** The GC job (simulated mid-session): the state and its rows are gone, nobody is pinged. */
    gc: wipe,
    /** A stored update no Yjs doc can apply. */
    poison: () => append(new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x00, 0x05])),
  };
}

class Conflict extends Error {}

/** The Markdown file in Files: a version per write, If-Match on the base. */
function fakeFile(text: string) {
  let n = 1;
  const file = {
    text,
    version: 'v1',
    writes: [] as Array<{ text: string; base: string | null }>,
    /** Activity's `restored` events, newest first. */
    restores: [] as string[],
    /** Someone restores an older version from Activity: a new version, and a restore event. */
    restore(next: string) {
      file.restores.unshift(`event:restore-${file.restores.length + 1}`);
      return file.external(next);
    },
    /** An agent's publish or a Files write: a new version, any text. */
    external(next: string) {
      file.text = next;
      file.version = `v${++n}`;
      return file.version;
    },
    async write(next: string, base: string | null) {
      file.writes.push({ text: next, base });
      if (base !== file.version) throw new Conflict('version_conflict');
      return file.external(next);
    },
    read: async (): Promise<Known> => ({ version: file.version, text: file.text }),
  };
  return file;
}

const placeholder = () => '';
let artifacts = 0;

/** One doc, its server, its file, and the tabs that open it. */
function world(markdown: string) {
  const clock = fakeClock();
  const server = fakeServer(clock);
  const file = fakeFile(markdown);
  const artifactId = `artifact-${++artifacts}`;
  let tabs = 0;
  async function open(options: { readOnly?: boolean } = {}) {
    const net = { cut: false, dropFlush: false };
    const offline = () => Object.assign(new Error('offline'), { status: 0 });
    const opened = await file.read();
    const base = docExtensions({ editable: !options.readOnly, placeholder });
    const leaders: boolean[] = [];
    let rebinds = 0;
    let rebind = () => {};
    const session: DocCoeditSession = createDocCoedit({
      projectId: 'project',
      artifactId,
      holder: `tab-${++tabs}`,
      readOnly: options.readOnly ?? false,
      opened,
      seed: (md) => seedUpdate(md, base),
      // A dead tab reaches no route: not the doc routes, not the save route.
      write: async (next, at) => {
        if (net.cut) throw offline();
        return file.write(next, at);
      },
      read: async () => {
        if (net.cut) throw offline();
        return file.read();
      },
      isConflict: (err) => err instanceof Conflict,
      restores: async () => [...file.restores],
      seeded: async () => server.state.seeded,
      onStatus: () => {},
      onFallback: () => {},
      onRebind: () => rebind(),
      onLeader: (leader) => leaders.push(leader),
      timers: clock.timers,
      createSync: (opts) => createArtifactDocSync({ ...opts, client: server.client(net) }),
    });
    const pushed: number[] = [];
    session.doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (typeof origin !== 'symbol') pushed.push(1);
    });
    await session.start();
    const ping = (seq: number) => session.notify(seq);
    server.state.pings.add(ping);
    const bind = () => {
      const bound = new Editor({
        editable: !options.readOnly,
        extensions: liveExtensions(base, { doc: session.doc, resolveSrc: (src) => src }),
      });
      editors.push(bound);
      return bound;
    };
    let editor = bind();
    let detach = session.attach(liveBridge(editor));
    rebind = () => {
      // As the web editor does: a new editor on the rebuilt doc, then attach.
      detach();
      editor.destroy();
      editor = bind();
      detach = session.attach(liveBridge(editor));
      rebinds += 1;
    };
    await clock.advance(0);
    return {
      session,
      get editor() {
        return editor;
      },
      net,
      leaders,
      pushed,
      rebinds: () => rebinds,
      markdown: () => liveBridge(editor).markdown(),
      /** The tab closes: its session sends what is unsent and releases the lease. */
      close() {
        server.state.pings.delete(ping);
        detach();
        session.close();
        editor.destroy();
      },
      /** The tab dies: no request leaves it any more. */
      kill() {
        server.state.pings.delete(ping);
        net.cut = true;
      },
    };
  }
  return { clock, server, file, open };
}

type Tab = Awaited<ReturnType<ReturnType<typeof world>['open']>>;

/** The position right after `quote` in the editor's text. */
function after(editor: Editor, quote: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (!node.isText) return true;
    const index = node.text!.indexOf(quote);
    if (index !== -1) found = pos + index + quote.length;
    return false;
  });
  if (found === -1) throw new Error(`Synthetic text missing: ${quote}`);
  return found;
}

/** The person types `text` right after `quote`, one keystroke (one transaction). */
function typeAfter(tab: Tab, quote: string, text: string) {
  const pos = after(tab.editor, quote);
  tab.editor.view.dispatch(tab.editor.state.tr.insertText(text, pos));
  tab.editor.commands.setTextSelection(pos + text.length);
}

describe('two editors on one doc', () => {
  test('opening a doc renders the file byte for byte and pushes nothing', async () => {
    const markdown = [
      '# Launch plan',
      '',
      'A **bold** step, `inline code` and a [link](https://example.com).',
      '',
      '- One',
      '- Two',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
    ].join('\n');
    const w = world(markdown);
    const a = await w.open();
    const b = await w.open();
    expect(a.markdown()).toBe(markdown);
    expect(b.markdown()).toBe(markdown);
    // The seed is the only row; binding an editor writes nothing to the shared doc.
    expect(w.server.state.rows).toHaveLength(1);
    expect(a.pushed).toHaveLength(0);
    expect(b.pushed).toHaveLength(0);
    a.close();
    b.close();
  });

  test('both type in one paragraph: both converge, and the leader writes both into the file', async () => {
    const w = world('Shared paragraph.\n');
    const a = await w.open();
    const b = await w.open();
    expect(a.session.leader).toBe(true);
    expect(b.session.leader).toBe(false);
    // Both type before either sees the other.
    typeAfter(a, 'Shared paragraph.', ' Alpha');
    typeAfter(b, 'Shared', ' beta');
    await w.clock.advance(100);
    expect(a.markdown()).toBe(b.markdown());
    expect(a.markdown()).toContain('Alpha');
    expect(a.markdown()).toContain('beta');
    expect(w.file.writes).toHaveLength(0);
    await w.clock.advance(2_500);
    expect(w.file.writes).toHaveLength(1);
    expect(w.file.text).toBe(a.markdown());
    expect(w.file.text).toBe('Shared beta paragraph. Alpha\n');
    expect(w.server.state.flushed).toMatchObject({ version: w.file.version, markdown: w.file.text });
    a.close();
    b.close();
  });

  test('an outside edit during typing is merged in both editors, and no typed character is lost', async () => {
    const w = world('First paragraph.\n\nSecond paragraph.\n');
    const a = await w.open();
    const b = await w.open();
    const typed = 'abcdefghij';
    for (let i = 0; i < typed.length; i++) {
      typeAfter(b, i === 0 ? 'Second paragraph.' : `Second paragraph. ${typed.slice(0, i)}`, i === 0 ? ` ${typed[i]}` : typed[i]);
      await w.clock.advance(120);
      if (i === 4) {
        // An agent publishes the file mid-typing; the leader hears `changed content`.
        const version = w.file.external('First paragraph.\n\nSecond paragraph.\n\nAgent line.\n');
        a.session.fileMoved(version);
      }
    }
    await w.clock.advance(3_000);
    for (const tab of [a, b]) {
      expect(tab.markdown()).toContain(`Second paragraph. ${typed}`);
      expect(tab.markdown()).toContain('Agent line.');
    }
    expect(a.markdown()).toBe(b.markdown());
    expect(w.file.text).toBe('First paragraph.\n\nSecond paragraph. abcdefghij\n\nAgent line.\n');
    a.close();
    b.close();
  });

  test("an outside edit met by the leader's write (409) is merged too", async () => {
    const w = world('One.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(b, 'One.', ' Typed');
    await w.clock.advance(100);
    // The agent writes before the leader's flush, and nobody pings: the write meets a 409.
    w.file.external('One.\n\nAgent.\n');
    await w.clock.advance(6_000);
    expect(a.markdown()).toBe('One. Typed\n\nAgent.\n');
    expect(b.markdown()).toBe(a.markdown());
    expect(w.file.text).toBe(a.markdown());
    a.close();
    b.close();
  });

  test('a restore to an older text both tabs had ends with the restored text in every tab and the file', async () => {
    const w = world('Base.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Base.', ' One');
    await w.clock.advance(2_600);
    expect(w.file.text).toBe('Base. One\n');
    typeAfter(b, 'Base. One', ' Two');
    await w.clock.advance(2_600);
    expect(w.file.text).toBe('Base. One Two\n');
    // Someone restores the version that said "Base. One" from Activity; the leader hears `changed content`.
    a.session.fileMoved(w.file.restore('Base. One\n'));
    await w.clock.advance(5_000);
    expect(a.markdown()).toBe('Base. One\n');
    expect(b.markdown()).toBe('Base. One\n');
    expect(w.file.text).toBe('Base. One\n');
    expect(w.file.writes).toHaveLength(2);
    a.close();
    b.close();
  });

  test("undo takes back the person's own typing, never the agent's merged change", async () => {
    const w = world('One.\n');
    const a = await w.open();
    typeAfter(a, 'One.', ' Mine');
    await w.clock.advance(100);
    const version = w.file.external('One.\n\nAgent.\n');
    a.session.fileMoved(version);
    await w.clock.advance(100);
    expect(a.markdown()).toBe('One. Mine\n\nAgent.\n');
    a.editor.commands.undo();
    expect(a.markdown()).toBe('One.\n\nAgent.\n');
    a.editor.commands.undo();
    expect(a.markdown()).toBe('One.\n\nAgent.\n');
    a.close();
  });

  test('a read-only viewer sees live text and never pushes, leads or writes', async () => {
    const w = world('Draft.\n');
    const a = await w.open();
    const viewer = await w.open({ readOnly: true });
    typeAfter(a, 'Draft.', ' More');
    await w.clock.advance(100);
    expect(viewer.markdown()).toBe('Draft. More\n');
    expect(viewer.pushed).toHaveLength(0);
    expect(viewer.leaders).not.toContain(true);
    a.close();
    viewer.close();
  });

  test('a writer pushes attributes of the wrong type: every other tab stays alive, typed, and in step', async () => {
    const card =
      '<div class="kx-embed"><a href="https://example.com/a" target="_blank" rel="noopener noreferrer"><span class="kx-embed-text">' +
      '<span class="kx-embed-title">Card</span><span class="kx-embed-url"><img class="kx-embed-favicon" ' +
      'src="https://www.google.com/s2/favicons?domain=example.com&amp;sz=128" alt="" referrerpolicy="no-referrer">' +
      '<span class="kx-embed-href">https://example.com/a</span></span></span></a></div>';
    const markdown = ['# Plan', '', `See the [notes](https://example.com/n).`, '', card, '', '![chart](media/chart.png)', '', '- [ ] Task', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', ''].join('\n');
    const w = world(markdown);
    const a = await w.open();
    const viewer = await w.open({ readOnly: true });
    // A raw Yjs client (not an editor): it takes the doc and sets values no editor writes.
    const writer = new Y.Doc();
    for (const row of w.server.state.rows) Y.applyUpdate(writer, row.update);
    const before = Y.encodeStateVector(writer);
    const poison: Record<string, Record<string, unknown>> = {
      heading: { level: { x: 1 } },
      linkEmbed: { href: { x: 1 }, title: 42 },
      image: { src: ['media/chart.png'] },
      taskItem: { checked: 'yes' },
      tableHeader: { colspan: { x: 1 }, colwidth: 'abc' },
      tableCell: { rowspan: -3 },
    };
    writer.transact(() => {
      for (const node of writer.getXmlFragment(COEDIT_FIELD).createTreeWalker(() => true)) {
        if (node instanceof Y.XmlElement)
          for (const [name, value] of Object.entries(poison[node.nodeName] ?? {})) node.setAttribute(name, value as string);
        // The link mark's href as an object (the offset in the text, not in its XML form).
        if (node instanceof Y.XmlText) {
          let offset = 0;
          for (const op of node.toDelta() as Array<{ insert: unknown }>) {
            const at = typeof op.insert === 'string' ? op.insert.indexOf('notes') : -1;
            if (at >= 0) node.format(offset + at, 5, { link: { href: { x: 1 } } });
            offset += typeof op.insert === 'string' ? op.insert.length : 1;
          }
        }
      }
    });
    await w.server.client({ cut: false, dropFlush: false }).push('project', 'artifact', Y.encodeStateAsUpdate(writer, before));
    await w.clock.advance(100);
    for (const tab of [a, viewer]) {
      expect(tab.editor.isDestroyed).toBe(false);
      const attrs: Record<string, Record<string, unknown>> = {};
      tab.editor.state.doc.descendants((node) => {
        attrs[node.type.name] ??= node.attrs;
        for (const mark of node.marks) attrs[mark.type.name] ??= mark.attrs;
      });
      expect(attrs.heading).toMatchObject({ level: 1 });
      expect(attrs.linkEmbed).toMatchObject({ href: '', title: '' });
      expect(attrs.image).toMatchObject({ src: null });
      expect(attrs.taskItem).toMatchObject({ checked: false });
      expect(attrs.tableHeader).toMatchObject({ colspan: 1, colwidth: null });
      expect(attrs.tableCell).toMatchObject({ rowspan: 1 });
      expect(attrs.link).toMatchObject({ href: null });
      // It still saves, and still takes an edit that reaches every tab.
      expect(tab.markdown()).toContain('- [ ] Task');
    }
    typeAfter(a, 'Task', ' done');
    await w.clock.advance(100);
    expect(viewer.markdown()).toContain('- [ ] Task done');
    expect(viewer.markdown()).toBe(a.markdown());
    a.close();
    viewer.close();
  });
});

/** How often `word` occurs in `text`. */
const count = (text: string, word: string) => text.split(word).length - 1;

describe('contract v2: a reset rebuilds every tab', () => {
  test('the GC deletes the state while both tabs type: both rebuild, nothing is duplicated or lost, the file holds both', async () => {
    const w = world('Shared paragraph.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Shared paragraph.', ' Alpha');
    typeAfter(b, 'Shared', ' beta');
    await w.clock.advance(100);
    w.server.gc();
    // Both keep typing; neither has the other's new words when the doc is gone.
    typeAfter(a, 'Alpha', ' more-a');
    typeAfter(b, 'beta', ' more-b');
    await w.clock.advance(8_000);
    expect(a.rebinds()).toBe(1);
    expect(b.rebinds()).toBe(1);
    expect(a.markdown()).toBe(b.markdown());
    for (const word of ['Shared', 'beta', 'more-b', 'paragraph', 'Alpha', 'more-a']) expect(count(a.markdown(), word)).toBe(1);
    expect(a.markdown()).toBe('Shared beta more-b paragraph. Alpha more-a\n');
    expect(w.file.text).toBe(a.markdown());
    // Each caret is back after the text it followed.
    const before = (tab: Tab) => tab.editor.state.doc.textBetween(Math.max(1, tab.editor.state.selection.from - 6), tab.editor.state.selection.from);
    expect(before(a)).toBe('more-a');
    expect(before(b)).toBe('more-b');
    expect(w.server.state.seeded).toBe(true);
    a.close();
    b.close();
  });

  test('POST /doc/reset while both tabs type: both rebuild, nothing is duplicated or lost', async () => {
    const w = world('Reset paragraph.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Reset paragraph.', ' Ra1');
    typeAfter(b, 'Reset', ' rb1');
    await w.clock.advance(100);
    typeAfter(a, 'Ra1', ' Ra2');
    // The reset lands while B's next word is still on its way.
    typeAfter(b, 'rb1', ' rb2');
    await w.server.client({ cut: false, dropFlush: false }).reset('p', 'x', { holder: 'outside' }).catch(() => {});
    if (w.server.state.seeded) {
      // The lease was held: reset as the leader would.
      await w.server.client({ cut: false, dropFlush: false }).reset('p', 'x', { holder: w.server.state.lease!.holder });
    }
    // The lease renewals of both tabs meet the gap before the re-seed (409 doc_not_seeded).
    await w.clock.advance(8_000);
    for (const tab of [a, b]) {
      expect(tab.rebinds()).toBe(1);
      for (const word of ['Ra1', 'Ra2', 'rb1', 'rb2']) expect(count(tab.markdown(), word)).toBe(1);
    }
    expect(a.markdown()).toBe(b.markdown());
    expect(w.file.text).toBe(a.markdown());
    a.close();
    b.close();
  });

  test('a poisoned row: the leader resets the doc, every tab rebuilds and keeps its text', async () => {
    const w = world('One paragraph.\n');
    const a = await w.open();
    const b = await w.open();
    const viewer = await w.open({ readOnly: true });
    typeAfter(a, 'One paragraph.', ' From A.');
    await w.clock.advance(100);
    typeAfter(b, 'From A.', ' From B.');
    await w.clock.advance(100);
    const epoch = w.server.state.epoch;
    w.server.poison();
    await w.clock.advance(8_000);
    expect(w.server.state.epoch).not.toBe(epoch);
    for (const tab of [a, b, viewer]) {
      expect(tab.rebinds()).toBe(1);
      expect(tab.markdown()).toBe('One paragraph. From A. From B.\n');
    }
    expect(w.file.text).toBe('One paragraph. From A. From B.\n');
    a.close();
    b.close();
    viewer.close();
  });
});

describe('the leader leaves', () => {
  test('it closes within 2 s of an edit: the other tab takes the lease and writes the tail', async () => {
    const w = world('Base.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Base.', ' Tail');
    await w.clock.advance(100);
    a.close();
    expect(w.file.writes).toHaveLength(0);
    await w.clock.advance(5_000);
    expect(b.session.leader).toBe(true);
    await w.clock.advance(100);
    expect(w.file.text).toBe('Base. Tail\n');
    b.close();
  });

  test('it dies: the other tab takes over once the lease runs out (15 s), and no edit is lost', async () => {
    const w = world('Base.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Base.', ' A');
    await w.clock.advance(100);
    a.kill();
    typeAfter(b, 'Base. A', ' B');
    await w.clock.advance(14_000);
    expect(b.session.leader).toBe(false);
    await w.clock.advance(7_000);
    expect(b.session.leader).toBe(true);
    await w.clock.advance(100);
    expect(w.file.text).toBe('Base. A B\n');
    b.close();
  });

  test('it dies after its write landed but before the flush record did: the next leader does not merge the doc into itself', async () => {
    const w = world('Base.\n');
    const a = await w.open();
    const b = await w.open();
    typeAfter(a, 'Base.', ' A');
    a.net.dropFlush = true;
    await w.clock.advance(2_100);
    // The file holds A's write; the server still records the seed as the last flush.
    expect(w.file.text).toBe('Base. A\n');
    expect(w.server.state.flushed?.markdown).toBe('Base.\n');
    a.kill();
    typeAfter(b, 'Base. A', ' B');
    await w.clock.advance(21_000);
    expect(b.session.leader).toBe(true);
    // Not "Base. A B" plus a second "Base. A" paragraph.
    expect(b.markdown()).toBe('Base. A B\n');
    expect(w.file.text).toBe('Base. A B\n');
    b.close();
  });
});

void Y;
