import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { EDITOR_BLOCK_PUSHES, EDITOR_BLOCK_SEED, EDITOR_PUSHES, EDITOR_SEED } from './doc-editor-updates.fixture';
import { decideRoots, rootLookups, type DocRootDecision } from './doc-roots';
import { placeDocUpdate, type DocPlacement } from './doc-scan';

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

/** A hand-written Yjs v1 update (lib0 encoding). */
class V1 {
  readonly out: number[] = [];
  uint(n: number): this {
    while (n > 0x7f) {
      this.out.push(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    this.out.push(n);
    return this;
  }
  byte(n: number): this {
    this.out.push(n);
    return this;
  }
  str(s: string): this {
    const b = new TextEncoder().encode(s);
    this.uint(b.length);
    for (const x of b) this.out.push(x);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.out);
  }
}

/** One client section of `count` structs from `clock`, then an empty delete set. */
function section(client: number, clock: number, count: number, write: (w: V1) => void): Uint8Array {
  const w = new V1().uint(1).uint(count).uint(client).uint(clock);
  write(w);
  return w.uint(0).done();
}
const ORIGIN = 0x80;
const RIGHT = 0x40;
const paragraph = (w: V1) => w.uint(3).str('paragraph');

/**
 * The server's index, in memory: what `artifact_doc_clients` and
 * `artifact_doc_roots` hold. `push` runs one update through the scan and
 * `decideRoots` exactly as the service does, and stores what it accepts.
 */
class Store {
  readonly next = new Map<number, number>();
  readonly roots = new Set<string>();

  place(update: Uint8Array, kind: 'push' | 'seed'): DocRootDecision {
    const scanned = placeDocUpdate(update, kind);
    if (!scanned.ok) throw new Error(`scan refused: ${scanned.reason}`);
    return this.decide(scanned.placement);
  }

  decide(p: DocPlacement): DocRootDecision {
    if (p.client === null) return { ok: true, roots: [], nextClock: 0 };
    const own = p.client;
    const nextClock = this.next.get(own) ?? 0;
    const lookups = rootLookups(p, nextClock);
    const storedRoots = new Set<number>();
    if (lookups.overlap) {
      for (const key of this.roots) {
        const [client, clock] = key.split(':').map(Number) as [number, number];
        if (client === own && clock >= lookups.overlap.from && clock < lookups.overlap.to && storedRoots.size < lookups.overlap.limit) storedRoots.add(clock);
      }
    }
    const decision = decideRoots(p, {
      nextClock,
      known: (client, clock) => (this.next.get(client) ?? 0) > clock,
      root: (client, clock) => this.roots.has(`${client}:${clock}`),
      storedRoots,
    });
    if (decision.ok) {
      for (const clock of decision.roots) this.roots.add(`${own}:${clock}`);
      this.next.set(own, Math.max(nextClock, decision.nextClock));
    }
    return decision;
  }
}

/** Every item Yjs placed in the root fragment `default`, deleted ones included: the truth the index must equal. */
function yjsRootIds(updates: Uint8Array[]): Set<string> {
  const doc = new Y.Doc({ gc: false });
  for (const update of updates) Y.applyUpdate(doc, update);
  const ids = new Set<string>();
  for (let item = doc.getXmlFragment('default')._start; item; item = item.right) {
    for (let i = 0; i < item.length; i++) ids.add(`${item.id.client}:${item.id.clock + i}`);
  }
  return ids;
}

/** Strix's 27 bytes: an XML text placed by its origin (another client's clock 0, a root element), then text inside it. */
const STRIX = 'AQKj4fJVAIeZ8KGyDwAGBACj4fJVAANwd24A';
const STRIX_ORIGIN_CLIENT = 4131944473;

describe('a root item placed by its origin must be an XML element too', () => {
  test('Strix’s 27-byte payload: the scan passes it (no parent in the bytes); against a doc whose root holds its origin → root_not_element', () => {
    const store = new Store();
    // A seed by the origin's client: one paragraph at the root, at clock 0.
    expect(store.place(section(STRIX_ORIGIN_CLIENT, 0, 1, (w) => paragraph(w.byte(7).uint(1).str('default'))), 'seed')).toEqual({ ok: true, roots: [0], nextClock: 1 });
    expect(placeDocUpdate(bytes(STRIX), 'push').ok).toBe(true);
    expect(store.place(bytes(STRIX), 'push')).toEqual({ ok: false, reason: 'root_not_element' });
  });

  test('the same bytes against a doc that never had that origin → unknown_origin (a forward reference)', () => {
    expect(new Store().place(bytes(STRIX), 'push')).toEqual({ ok: false, reason: 'unknown_origin' });
  });

  test('placed by its origin or by its right origin next to a root element: text, a string or an attribute → root_not_element; an element → a new root item', () => {
    const fresh = () => {
      const store = new Store();
      store.place(section(9, 0, 1, (w) => paragraph(w.byte(7).uint(1).str('default'))), 'seed');
      return store;
    };
    for (const [name, flag] of [['origin', ORIGIN], ['right origin', RIGHT]] as const) {
      for (const [content, write] of [
        ['XML text', (w: V1) => w.byte(flag | 7).uint(9).uint(0).uint(6)],
        ['string', (w: V1) => w.byte(flag | 4).uint(9).uint(0).str('root text')],
        ['attribute', (w: V1) => w.byte(flag | 8).uint(9).uint(0).uint(1).byte(120)],
      ] as const) {
        expect({ name, content, decision: fresh().place(section(5, 0, 1, write), 'push') }).toEqual({ name, content, decision: { ok: false, reason: 'root_not_element' } });
      }
      const element = fresh().place(section(5, 0, 1, (w) => paragraph(w.byte(flag | 7).uint(9).uint(0))), 'push');
      expect({ name, element }).toEqual({ name, element: { ok: true, roots: [0], nextClock: 1 } });
    }
  });

  test('a chain inside one push: an element placed at the root, then text placed after that element → root_not_element', () => {
    const store = new Store();
    store.place(section(9, 0, 1, (w) => paragraph(w.byte(7).uint(1).str('default'))), 'seed');
    const chain = section(5, 0, 2, (w) => {
      paragraph(w.byte(ORIGIN | 7).uint(9).uint(0)); // 5:0, a root element after 9:0
      w.byte(ORIGIN | 4).uint(5).uint(0).str('x'); // 5:1, text after 5:0: at the root
    });
    expect(store.place(chain, 'push')).toEqual({ ok: false, reason: 'root_not_element' });
  });

  test('text placed after text inside an element is not at the root; a later item placed after a stored root item is', () => {
    const store = new Store();
    store.place(section(9, 0, 3, (w) => {
      paragraph(w.byte(7).uint(1).str('default')); // 9:0 root paragraph
      w.byte(7).uint(0).uint(9).uint(0).uint(6); // 9:1 XML text inside 9:0
      w.byte(4).uint(0).uint(9).uint(1).str('ab'); // 9:2..3 text inside 9:1
    }), 'seed');
    expect(store.place(section(5, 0, 1, (w) => w.byte(ORIGIN | 4).uint(9).uint(3).str('c')), 'push')).toEqual({ ok: true, roots: [], nextClock: 1 });
    expect(store.place(section(5, 1, 1, (w) => w.byte(ORIGIN | 4).uint(9).uint(0).str('d')), 'push')).toEqual({ ok: false, reason: 'root_not_element' });
  });
});

describe('the index stays exact: every ID a push names is known, and each clock is placed once', () => {
  test('a push that starts past its client’s stored clocks → clock_gap (Yjs would hold it until the hole fills, then place it)', () => {
    const store = new Store();
    store.place(section(9, 0, 1, (w) => paragraph(w.byte(7).uint(1).str('default'))), 'seed');
    expect(store.place(section(5, 3, 1, (w) => w.byte(ORIGIN | 4).uint(5).uint(1).str('x')), 'push')).toEqual({ ok: false, reason: 'clock_gap' });
    // A Skip leaves a hole inside the push.
    const skip = section(5, 0, 2, (w) => {
      w.byte(10).uint(2);
      paragraph(w.byte(ORIGIN | 7).uint(9).uint(0));
    });
    expect(store.place(skip, 'push')).toEqual({ ok: false, reason: 'clock_gap' });
  });

  test('a retry of a stored push (its answer was lost) passes and adds nothing; a re-send that places a stored clock elsewhere → clock_overlap', () => {
    const store = new Store();
    store.place(section(9, 0, 1, (w) => paragraph(w.byte(7).uint(1).str('default'))), 'seed');
    const first = section(5, 0, 2, (w) => {
      paragraph(w.byte(ORIGIN | 7).uint(9).uint(0)); // 5:0 root
      w.byte(7).uint(0).uint(5).uint(0).uint(6); // 5:1 inside 5:0
    });
    expect(store.place(first, 'push')).toEqual({ ok: true, roots: [0], nextClock: 2 });
    expect(store.place(first, 'push')).toEqual({ ok: true, roots: [], nextClock: 2 });
    // The retry merged with the next edit: the stored part is checked, the new part placed.
    const merged = section(5, 0, 3, (w) => {
      paragraph(w.byte(ORIGIN | 7).uint(9).uint(0));
      w.byte(7).uint(0).uint(5).uint(0).uint(6);
      paragraph(w.byte(ORIGIN | 7).uint(5).uint(0)); // 5:2 root, after 5:0
    });
    expect(store.place(merged, 'push')).toEqual({ ok: true, roots: [2], nextClock: 3 });
    // 5:0 again, now inside 9:0: stored as a root item, so this is another doc. Refused.
    const moved = section(5, 0, 1, (w) => paragraph(w.byte(7).uint(0).uint(9).uint(0)));
    expect(store.place(moved, 'push')).toEqual({ ok: false, reason: 'clock_overlap' });
    // 5:1 again, now at the root: refused the same way.
    const promoted = section(5, 1, 1, (w) => paragraph(w.byte(ORIGIN | 7).uint(9).uint(0)));
    expect(store.place(promoted, 'push')).toEqual({ ok: false, reason: 'clock_overlap' });
  });

  test('a struct that starts in the stored clocks and ends past them → clock_overlap (no editor writes one: a push starts where the last one ended)', () => {
    const store = new Store();
    store.place(section(9, 0, 3, (w) => {
      paragraph(w.byte(7).uint(1).str('default'));
      w.byte(7).uint(0).uint(9).uint(0).uint(6);
      w.byte(4).uint(0).uint(9).uint(1).str('ab');
    }), 'seed');
    expect(store.place(section(5, 0, 1, (w) => w.byte(ORIGIN | 4).uint(9).uint(3).str('cd')), 'push').ok).toBe(true);
    expect(store.place(section(5, 1, 1, (w) => w.byte(ORIGIN | 4).uint(9).uint(3).str('xyz')), 'push')).toEqual({ ok: false, reason: 'clock_overlap' });
  });

  test('a seed names only its own items: an origin outside it → unknown_origin', () => {
    expect(new Store().place(section(9, 0, 1, (w) => paragraph(w.byte(ORIGIN | 7).uint(4).uint(0))), 'seed')).toEqual({ ok: false, reason: 'unknown_origin' });
  });

  test('placement is linear and bounded: a push at the struct cap of one-byte-content items is placed and decided in bounded time and memory', () => {
    const count = 100_000;
    const update = section(5, 0, count, (w) => {
      // Each one after the XML text inside 9:0, so none is at the root: the decision walks all of them.
      for (let i = 0; i < count; i++) w.byte(ORIGIN | 4).uint(9).uint(1).str('x');
    });
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const scanned = placeDocUpdate(update, 'push');
    if (!scanned.ok) throw new Error(scanned.reason);
    const store = new Store();
    store.place(section(9, 0, 2, (w) => {
      paragraph(w.byte(7).uint(1).str('default'));
      w.byte(7).uint(0).uint(9).uint(0).uint(6);
    }), 'seed');
    expect(store.decide(scanned.placement)).toEqual({ ok: true, roots: [], nextClock: count });
    expect(performance.now() - started).toBeLessThan(500);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 * 1024 * 1024);
  });

  test('the lookups a push needs are bounded by its structs: distinct IDs outside it, at most two per struct', () => {
    const count = 1000;
    const update = section(5, 0, count, (w) => {
      for (let i = 0; i < count; i++) w.byte(ORIGIN | RIGHT | 4).uint(9).uint(i % 10).uint(9).uint(i % 7).str('x');
    });
    const scanned = placeDocUpdate(update, 'push');
    if (!scanned.ok) throw new Error(scanned.reason);
    const lookups = rootLookups(scanned.placement, 0);
    expect(lookups.refs.length).toBe(10);
    expect(lookups.refs.length).toBeLessThanOrEqual(2 * count);
  });
});

describe('the real editor’s updates pass, and the index equals what Yjs places at the root', () => {
  for (const [name, seed, pushes] of [
    ['inline edits (type, marks, image, split, paste, delete a block)', EDITOR_SEED, EDITOR_PUSHES],
    ['block edits (insert, split, join, delete, undo, redo, Enter, delete all)', EDITOR_BLOCK_SEED, EDITOR_BLOCK_PUSHES],
  ] as const) {
    test(name, () => {
      const store = new Store();
      expect(store.place(bytes(seed), 'seed').ok).toBe(true);
      for (const push of pushes) {
        expect({ action: push.action, ok: store.place(bytes(push.update), 'push').ok }).toEqual({ action: push.action, ok: true });
      }
      const truth = yjsRootIds([seed, ...pushes.map((push) => push.update)].map(bytes));
      expect([...store.roots].sort()).toEqual([...truth].sort());
      // Undo and redo restore blocks as new items placed by origin: the index holds more than the seed's explicit roots.
      expect(truth.size).toBeGreaterThan(1);
    });
  }
});
