import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { DOC_COMPACT_WINDOW_BYTES, DOC_COMPACT_WINDOW_STRUCTS, compactionWindow } from './doc-rules';
import { DOC_MAX_STRUCTS, checkDocUpdate, compactDocUpdates, measureDocUpdate } from './doc-yjs';

/** A doc shaped like tiptap's: paragraphs of text in the `default` fragment. */
function paragraphs(doc: Y.Doc): string {
  return doc.getXmlFragment('default').toString();
}

function addParagraph(doc: Y.Doc, at: number, text: string): void {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(at, [p]);
}

/** Every update a doc emits, in order: what a client would POST. */
function record(doc: Y.Doc): Uint8Array[] {
  const out: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => out.push(update));
  return out;
}

/** Test-side only: the server never integrates an update. */
function fresh(updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/** The pushes of two people typing at once on one seeded doc, and the seed. */
function twoWriters(): { seed: Uint8Array; pushes: Uint8Array[] } {
  const seedDoc = new Y.Doc();
  addParagraph(seedDoc, 0, 'Launch plan');
  addParagraph(seedDoc, 1, 'Owner: tbd');
  const seed = Y.encodeStateAsUpdate(seedDoc);
  const a = fresh([seed]);
  const b = fresh([seed]);
  const fromA = record(a);
  const fromB = record(b);
  const pushes: Uint8Array[] = [];
  for (let i = 0; i < 30; i++) {
    // Both edit before either sees the other's change, as two tabs do.
    ((a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, `a${i} `);
    if (i % 7 === 0) addParagraph(b, 1, `note ${i}`);
    else ((b.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, `b${i} `);
    if (i % 5 === 0) ((a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(0, 2);
    if (i % 9 === 8 && b.getXmlFragment('default').length > 2) b.getXmlFragment('default').delete(1, 1);
    const pushedA = fromA.splice(0);
    const pushedB = fromB.splice(0);
    pushes.push(...pushedA, ...pushedB);
    for (const u of pushedB) Y.applyUpdate(a, u);
    for (const u of pushedA) Y.applyUpdate(b, u);
  }
  expect(paragraphs(a)).toBe(paragraphs(b));
  return { seed, pushes };
}

/** A hand-written Yjs v1 update (lib0 encoding), for shapes no honest client produces. */
class V1 {
  readonly bytes: number[] = [];
  uint(n: number): this {
    while (n > 0x7f) {
      this.bytes.push(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    this.bytes.push(n);
    return this;
  }
  byte(n: number): this {
    this.bytes.push(n);
    return this;
  }
  str(s: string): this {
    const b = new TextEncoder().encode(s);
    this.uint(b.length);
    this.bytes.push(...b);
    return this;
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const CLIENT = 123456789;
const ORIGIN = 0x80;
const RIGHT_ORIGIN = 0x40;
const STRING = 4;

/** One item of CLIENT at clock 0 with `info` flags, then whatever `rest` writes, then an empty delete set. */
function oneItem(info: number, rest: (w: V1) => void): Uint8Array {
  const w = new V1().uint(1).uint(1).uint(CLIENT).uint(0).byte(info);
  rest(w);
  return w.str('x').uint(0).done();
}

describe('checkDocUpdate', () => {
  test('every update two real tabs push passes as a push; their seed passes as a seed', () => {
    const { seed, pushes } = twoWriters();
    expect(checkDocUpdate(seed, 'seed')).toEqual({ ok: true });
    for (const push of pushes) expect(checkDocUpdate(push, 'push')).toEqual({ ok: true });
  });

  test('a delete-only update (a backspace) and an empty update pass as a push', () => {
    const doc = new Y.Doc();
    addParagraph(doc, 0, 'hello');
    const pushes = record(doc);
    ((doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(4, 1);
    expect(Y.decodeUpdate(pushes[0]!).structs).toHaveLength(0);
    expect(checkDocUpdate(pushes[0]!, 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(new Uint8Array([0, 0]), 'push')).toEqual({ ok: true });
  });

  test('THE poison: 17 bytes, an item whose origin is its own future clock → refused (it decodes, and applyUpdate throws)', () => {
    const poison = new Uint8Array(Buffer.from('AQGVmu86AISVmu86yAEBeAA=', 'base64'));
    expect(poison.length).toBe(17);
    expect([...poison]).toEqual([...oneItem(ORIGIN | STRING, (w) => w.uint(CLIENT).uint(200))]);
    expect(Y.decodeUpdate(poison).structs).toHaveLength(1);
    expect(() => Y.applyUpdate(new Y.Doc(), poison)).toThrow();
    expect(checkDocUpdate(poison, 'push')).toEqual({ ok: false, reason: 'self_reference' });
    expect(checkDocUpdate(poison, 'seed')).toEqual({ ok: false, reason: 'self_reference' });
  });

  test('a right origin or a parent at its own clock or later → refused', () => {
    expect(checkDocUpdate(oneItem(RIGHT_ORIGIN | STRING, (w) => w.uint(CLIENT).uint(0)), 'push')).toEqual({ ok: false, reason: 'self_reference' });
    expect(checkDocUpdate(oneItem(STRING, (w) => w.uint(0).uint(CLIENT).uint(5)), 'push')).toEqual({ ok: false, reason: 'self_reference' });
    // The same shapes naming another client are ordinary (that client's earlier item).
    expect(checkDocUpdate(oneItem(ORIGIN | STRING, (w) => w.uint(42).uint(200)), 'push')).toEqual({ ok: true });
  });

  test('structs of two clients: refused as a push, accepted as a seed', () => {
    const { pushes } = twoWriters();
    const a = pushes.find((u) => Y.decodeUpdate(u).structs.length > 0)!;
    const clientA = Y.decodeUpdate(a).structs[0]!.id.client;
    const b = pushes.find((u) => Y.decodeUpdate(u).structs.some((s) => s.id.client !== clientA))!;
    const both = Y.mergeUpdates([a, b]);
    expect(checkDocUpdate(both, 'push')).toEqual({ ok: false, reason: 'many_clients' });
    expect(checkDocUpdate(both, 'seed')).toEqual({ ok: true });
  });

  test(`more than ${DOC_MAX_STRUCTS} structs → refused`, () => {
    const many = (count: number) => {
      const w = new V1().uint(1).uint(count).uint(CLIENT).uint(0);
      for (let i = 0; i < count; i++) w.byte(0).uint(1); // GC structs of length 1
      return w.uint(0).done();
    };
    expect(checkDocUpdate(many(DOC_MAX_STRUCTS), 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(many(DOC_MAX_STRUCTS + 1), 'push')).toEqual({ ok: false, reason: 'too_many_structs' });
  });

  test('bytes that are not a Yjs update → refused', () => {
    expect(checkDocUpdate(new Uint8Array(), 'push')).toEqual({ ok: false, reason: 'malformed' });
    expect(checkDocUpdate(new TextEncoder().encode('not a yjs update at all'), 'push').ok).toBe(false);
    expect(checkDocUpdate(new Uint8Array(32).fill(0xff), 'seed')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('compactDocUpdates (Y.mergeUpdates, never integration)', () => {
  test('one row holds every update: a fresh client gets the same doc, byte for byte the flat merge', () => {
    const { seed, pushes } = twoWriters();
    const log = [seed, ...pushes];
    const compacted = compactDocUpdates(log, { maxBytes: 8 * 1024 * 1024, maxStructs: 1_000_000 })!;
    expect(Buffer.from(compacted).equals(Buffer.from(Y.mergeUpdates(log)))).toBe(true);
    const expected = paragraphs(fresh(log));
    expect(expected).toContain('note 28');
    expect(paragraphs(fresh([compacted]))).toBe(expected);
    expect([...Y.encodeStateVector(fresh([compacted]))]).toEqual([...Y.encodeStateVector(fresh(log))]);
  });

  test('a client that already applied part of the merged range converges', () => {
    const { seed, pushes } = twoWriters();
    const log = [seed, ...pushes];
    const client = fresh(log.slice(0, 25));
    Y.applyUpdate(client, compactDocUpdates(log.slice(0, 40), { maxBytes: 8 * 1024 * 1024, maxStructs: 1_000_000 })!);
    for (const update of log.slice(40)) Y.applyUpdate(client, update);
    expect(paragraphs(client)).toBe(paragraphs(fresh(log)));
  });

  test('a crafted set (3 clients, ~500 KB each, every item at one position) compacts fast, or is skipped, without integrating', () => {
    const crafted = [11, 22, 33].map((client) => {
      const count = 80_000;
      const w = new V1().uint(1).uint(count).uint(client).uint(0);
      for (let i = 0; i < count; i++) w.byte(STRING).uint(0).uint(42).uint(0).str('x'); // no origins: all at the start of one element (42:0)
      return w.uint(0).done();
    });
    expect(crafted.every((row) => row.length > 450_000)).toBe(true);
    // All three would merge into 240,000 structs, past the scan cap of a stored row: skipped, fast.
    let started = performance.now();
    expect(compactDocUpdates(crafted, { maxBytes: 8 * 1024 * 1024, maxStructs: 1_000_000 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
    // Two of them (160,000 structs) merge.
    started = performance.now();
    const merged = compactDocUpdates(crafted.slice(0, 2), { maxBytes: 8 * 1024 * 1024, maxStructs: 1_000_000 });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(Y.decodeUpdate(merged!).structs).toHaveLength(160_000);
    // Past the cap the merge is dropped: the caller keeps the rows.
    started = performance.now();
    expect(compactDocUpdates(crafted, { maxBytes: 1_000_000, maxStructs: 1_000_000 })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('500 rows of one client with interleaved clocks merge in bounded time (a merge tree, not one 500-way merge)', () => {
    const rows = 500;
    const perRow = 200;
    const interleaved = Array.from({ length: rows }, (_, r) => {
      const w = new V1().uint(1).uint(perRow * 2 - 1).uint(7).uint(r);
      for (let k = 0; k < perRow; k++) {
        if (k > 0) w.byte(10).uint(rows - 1); // a Skip over the other rows' clocks
        w.byte(STRING).uint(0).uint(42).uint(0).str('x');
      }
      return w.uint(0).done();
    });
    const started = performance.now();
    const merged = compactDocUpdates(interleaved, { maxBytes: 8 * 1024 * 1024, maxStructs: 1_000_000 })!;
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(Buffer.from(merged).equals(Buffer.from(Y.mergeUpdates(interleaved)))).toBe(true);
  });
});

describe('a merged row meets the caps of a push', () => {
  /** The review's shape: one push of `count` ContentDeleted items of length 1 (four bytes each), chained by origin. */
  function deletedRow(client: number, clock0: number, count: number): Uint8Array {
    const w = new V1().uint(1).uint(count).uint(client).uint(clock0);
    for (let i = 0; i < count; i++) {
      const clock = clock0 + i;
      if (clock === 0) w.byte(1).uint(0).uint(42).uint(0).uint(1);
      else w.byte(0x80 | 1).uint(client).uint(clock - 1).uint(1);
    }
    return w.uint(0).done();
  }

  test('32 pushes of 8,250 ContentDeleted items (each a valid push) would merge into 264,000 structs: refused (null), never stored', () => {
    const rows = Array.from({ length: 32 }, (_, p) => deletedRow(5, p * 8_250, 8_250));
    for (const row of rows) expect(checkDocUpdate(row, 'push')).toEqual({ ok: true });
    expect(compactDocUpdates(rows, { maxBytes: 8 * 1024 * 1024, maxStructs: DOC_MAX_STRUCTS })).toBeNull();
  });

  test('a merge within the caps is kept, and the scan counts its structs', () => {
    const rows = Array.from({ length: 4 }, (_, p) => deletedRow(5, p * 8_250, 8_250));
    const merged = compactDocUpdates(rows, { maxBytes: 512 * 1024, maxStructs: DOC_MAX_STRUCTS })!;
    expect(merged).not.toBeNull();
    expect(measureDocUpdate(merged, 'seed')).toEqual({ ok: true, structs: 33_000 });
    // Past the byte cap: refused as well.
    expect(compactDocUpdates(rows, { maxBytes: 64 * 1024, maxStructs: DOC_MAX_STRUCTS })).toBeNull();
  });
});

describe('one compaction step is bounded', () => {
  function deletedRow(client: number, clock0: number, count: number): Uint8Array {
    const w = new V1().uint(1).uint(count).uint(client).uint(clock0);
    for (let i = 0; i < count; i++) {
      const clock = clock0 + i;
      if (clock === 0) w.byte(1).uint(0).uint(42).uint(0).uint(1);
      else w.byte(0x80 | 1).uint(client).uint(clock - 1).uint(1);
    }
    return w.uint(0).done();
  }
  /** Interleaved clocks of one client across rows: the most decoder re-sorting per struct. */
  function interleaved(rows: number, perRow: number): Uint8Array[] {
    return Array.from({ length: rows }, (_, r) => {
      const w = new V1().uint(1).uint(perRow * 2 - 1).uint(7).uint(r);
      for (let k = 0; k < perRow; k++) {
        if (k > 0) w.byte(10).uint(rows - 1);
        w.byte(1).uint(0).uint(42).uint(0).uint(1);
      }
      return w.uint(0).done();
    });
  }
  const window = (updates: Uint8Array[]) => {
    const rows = updates.map((u, i) => {
      const measured = measureDocUpdate(u, 'seed');
      if (!measured.ok) throw new Error(`row ${i} refused: ${measured.reason}`);
      return { seq: i + 1, size: u.length, structs: measured.structs };
    });
    // Pad past the threshold with empty rows so a window is chosen.
    const padded = [...rows, ...Array.from({ length: 501 }, (_, i) => ({ seq: rows.length + i + 1, size: 2, structs: 0 }))];
    const plan = compactionWindow(padded)!;
    return updates.slice(plan.fromSeq - 1, Math.min(plan.toSeq, updates.length));
  };

  for (const [name, updates] of [
    ['the review’s shape: 64 pushes of 8,250 four-byte ContentDeleted items', Array.from({ length: 64 }, (_, p) => deletedRow(5, p * 8_250, 8_250))],
    ['500 rows of one client with interleaved clocks', interleaved(500, 200)],
  ] as const) {
    test(`${name}: the window holds at most ${DOC_COMPACT_WINDOW_STRUCTS} structs and ${DOC_COMPACT_WINDOW_BYTES / 1024} KiB, and merges in < 100 ms`, () => {
      const chosen = window(updates);
      const structs = chosen.reduce((n, u) => n + (measureDocUpdate(u, 'seed') as { structs: number }).structs, 0);
      expect(structs).toBeLessThanOrEqual(DOC_COMPACT_WINDOW_STRUCTS);
      expect(chosen.reduce((n, u) => n + u.length, 0)).toBeLessThanOrEqual(DOC_COMPACT_WINDOW_BYTES);
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        expect(compactDocUpdates(chosen, { maxBytes: 512 * 1024, maxStructs: DOC_MAX_STRUCTS })).not.toBeNull();
        best = Math.min(best, performance.now() - started);
      }
      expect(best).toBeLessThan(100);
    });
  }
});
