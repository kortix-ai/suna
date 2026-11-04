import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { EDITOR_PUSHES, EDITOR_SEED } from './doc-editor-updates.fixture';
import { DOC_MAX_DELETES, DOC_MAX_STRUCTS, checkDocUpdate, measureDocUpdate } from './doc-yjs';

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

/** A hand-written Yjs v1 update (lib0 encoding), for shapes the editor never produces. */
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

const CLIENT = 77;
const PARENT_KEY = 1; // parent info: a root type name follows

/** One client, `count` items written by `item(w, i)` after the header, then an empty delete set. */
function items(count: number, item: (w: V1, i: number) => void): Uint8Array {
  const w = new V1().uint(1).uint(count).uint(CLIENT).uint(0);
  for (let i = 0; i < count; i++) item(w, i);
  return w.uint(0).done();
}

/** An item at the start of `default` (no origins) with content ref `ref` and its content. */
const rootItem = (ref: number, content: (w: V1) => void) => (w: V1) => {
  w.byte(ref).uint(PARENT_KEY).str('default');
  content(w);
};

/** An item inside an element of another client (parent by ID: not the root) with content ref `ref`. */
const childItem = (ref: number, content: (w: V1) => void) => (w: V1) => {
  w.byte(ref).uint(0).uint(42).uint(0);
  content(w);
};

describe('the editor’s own updates pass', () => {
  test('the recorded seed passes as a seed, and every recorded push as a push', () => {
    expect(checkDocUpdate(bytes(EDITOR_SEED), 'seed')).toEqual({ ok: true });
    for (const push of EDITOR_PUSHES) expect({ action: push.action, check: checkDocUpdate(bytes(push.update), 'push') }).toEqual({ action: push.action, check: { ok: true } });
  });

  test('a merge of the recorded updates (what compaction stores) passes as a seed', () => {
    const merged = Y.mergeUpdates([bytes(EDITOR_SEED), ...EDITOR_PUSHES.map((p) => bytes(p.update))]);
    expect(checkDocUpdate(merged, 'seed')).toEqual({ ok: true });
  });
});

describe('measureDocUpdate', () => {
  test('counts the structs of every recorded editor update exactly as Y.decodeUpdate does', () => {
    for (const b64 of [EDITOR_SEED, ...EDITOR_PUSHES.map((p) => p.update)]) {
      const update = bytes(b64);
      expect(measureDocUpdate(update, 'seed')).toEqual({ ok: true, structs: Y.decodeUpdate(update).structs.length });
    }
    expect(measureDocUpdate(new Uint8Array([0xff]), 'seed')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('content the editor never emits is refused before any decode', () => {
  for (const [name, ref, content] of [
    ['ContentJSON (2)', 2, (w: V1) => w.uint(1).str('{"a":1}')],
    ['ContentBinary (3)', 3, (w: V1) => w.uint(3).byte(1).byte(2).byte(3)],
    ['ContentEmbed (5)', 5, (w: V1) => w.str('{"image":"x"}')],
    ['ContentDoc (9)', 9, (w: V1) => w.str('guid').byte(127)],
    ['an unknown ref (11)', 11, (w: V1) => w.byte(0)],
  ] as const) {
    test(`${name} → content_not_allowed, as a push and as a seed`, () => {
      const update = items(1, rootItem(ref, content));
      expect(checkDocUpdate(update, 'push')).toEqual({ ok: false, reason: 'content_not_allowed' });
      expect(checkDocUpdate(update, 'seed')).toEqual({ ok: false, reason: 'content_not_allowed' });
    });
  }

  test('a shared type other than an XML element or XML text (a YMap, a YText) → content_not_allowed', () => {
    for (const typeRef of [0, 1, 2, 4, 5]) {
      const update = items(1, rootItem(7, (w) => (typeRef === 5 ? w.uint(typeRef).str('hook') : w.uint(typeRef))));
      expect({ typeRef, check: checkDocUpdate(update, 'seed') }).toEqual({ typeRef, check: { ok: false, reason: 'content_not_allowed' } });
    }
  });

  test('the review’s payload: ~87,000 six-byte ContentDoc items in a 512 KiB push → refused in milliseconds, with no heap growth', () => {
    // Each item `09 01 00 00 76 00`: ContentDoc at the root of `''`, an empty guid, `{}` options.
    // The review counted 87,381; with this header 87,380 fill the 512 KiB push limit exactly.
    const subdoc = (w: V1) => w.byte(9).uint(PARENT_KEY).str('').str('').byte(118).uint(0);
    const payload = items(87_380, subdoc);
    expect(payload.length).toBe(512 * 1024 - 1);
    // Yjs decodes the shape (building one Y.Doc per item: that is the cost); the decode-based check let it through.
    expect(Y.decodeUpdate(items(10, subdoc)).structs).toHaveLength(10);
    Bun.gc(true);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    expect(checkDocUpdate(payload, 'push')).toEqual({ ok: false, reason: 'content_not_allowed' });
    expect(performance.now() - started).toBeLessThan(50);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(8 * 1024 * 1024);
  });

  test('the scan’s own worst case: 512 KiB of allowed attribute items with nested values → checked in bounded time and heap', () => {
    // ContentAny items (node attributes) with a nested object each: the most work per byte the scan accepts.
    const payload = items(35_500, (w, i) => {
      if (i === 0) w.byte(8).uint(0).uint(42).uint(0);
      else w.byte(0x80 | 8).uint(CLIENT).uint(i - 1);
      w.uint(1).byte(118).uint(1).str('k').byte(117).uint(2).byte(125).byte(5).byte(120);
    });
    expect(payload.length).toBeGreaterThan(400 * 1024);
    expect(payload.length).toBeLessThanOrEqual(512 * 1024);
    Bun.gc(true);
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    expect(checkDocUpdate(payload, 'push')).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(250);
    expect(process.memoryUsage().heapUsed - heap).toBeLessThan(32 * 1024 * 1024);
  });
});

describe('the root of the doc holds XML elements only', () => {
  test('an XML text, a string or an attribute placed at the root `default` → root_not_element (y-tiptap throws on any root child that is not an element)', () => {
    for (const [name, item] of [
      ['XML text', rootItem(7, (w) => w.uint(6))],
      ['string', rootItem(4, (w) => w.str('root text'))],
      ['format', rootItem(6, (w) => w.str('bold').str('true'))],
      ['attribute', rootItem(8, (w) => w.uint(1).byte(120))],
    ] as const) {
      const update = items(1, item);
      expect({ name, push: checkDocUpdate(update, 'push'), seed: checkDocUpdate(update, 'seed') })
        .toEqual({ name, push: { ok: false, reason: 'root_not_element' }, seed: { ok: false, reason: 'root_not_element' } });
    }
  });

  test('a root type the editor never uses, and a map entry on `default` → content_not_allowed; the position-migration map of y-tiptap passes', () => {
    const otherRoot = items(1, (w) => w.byte(7).uint(PARENT_KEY).str('meta').uint(3).str('paragraph'));
    expect(checkDocUpdate(otherRoot, 'seed')).toEqual({ ok: false, reason: 'content_not_allowed' });
    const migrations = items(1, (w) => w.byte(0x20 | 8).uint(PARENT_KEY).str('__tiptap_position_migrations:root:default').str('123:4').uint(1).byte(125).byte(3));
    expect(checkDocUpdate(migrations, 'push')).toEqual({ ok: true });
    const rootEntry = items(1, (w) => w.byte(0x20 | 7).uint(PARENT_KEY).str('default').str('key').uint(3).str('paragraph'));
    expect(checkDocUpdate(rootEntry, 'seed')).toEqual({ ok: false, reason: 'content_not_allowed' });
  });

  test('an XML element at the root, and text inside an element, pass', () => {
    expect(checkDocUpdate(items(1, rootItem(7, (w) => w.uint(3).str('paragraph'))), 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(items(1, childItem(7, (w) => w.uint(6))), 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(items(1, childItem(4, (w) => w.str('text'))), 'push')).toEqual({ ok: true });
  });
});

describe('caps, counted in the same pass', () => {
  test(`more than ${DOC_MAX_STRUCTS} structs (declared or real) → too_many_structs`, () => {
    const gc = (count: number) => items(count, (w) => w.byte(0).uint(1));
    expect(checkDocUpdate(gc(DOC_MAX_STRUCTS), 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(gc(DOC_MAX_STRUCTS + 1), 'push')).toEqual({ ok: false, reason: 'too_many_structs' });
    // A header that declares 2^31 structs in a few bytes is refused before any loop.
    expect(checkDocUpdate(new V1().uint(1).uint(2 ** 31).uint(CLIENT).uint(0).done(), 'seed')).toEqual({ ok: false, reason: 'too_many_structs' });
  });

  test(`more than ${DOC_MAX_DELETES} delete-set ranges → too_many_deletes`, () => {
    const deletes = (count: number) => {
      const w = new V1().uint(0).uint(1).uint(CLIENT).uint(count);
      for (let i = 0; i < count; i++) w.uint(i * 2).uint(1);
      return w.done();
    };
    expect(checkDocUpdate(deletes(1000), 'push')).toEqual({ ok: true });
    expect(checkDocUpdate(deletes(DOC_MAX_DELETES + 1), 'push')).toEqual({ ok: false, reason: 'too_many_deletes' });
  });

  test('strings Yjs would refuse (invalid UTF-8) and format values that are not JSON → malformed', () => {
    const badUtf8 = new V1().uint(1).uint(1).uint(CLIENT).uint(0).byte(4).uint(0).uint(42).uint(0).uint(2).byte(0xc3).byte(0x28).uint(0).done();
    expect(() => Y.decodeUpdate(badUtf8)).toThrow();
    expect(checkDocUpdate(badUtf8, 'push')).toEqual({ ok: false, reason: 'malformed' });
    const badJson = items(1, childItem(6, (w) => w.str('bold').str('{not json')));
    expect(() => Y.decodeUpdate(badJson)).toThrow();
    expect(checkDocUpdate(badJson, 'push')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('bytes after the delete set → malformed', () => {
    const real = bytes(EDITOR_PUSHES[0]!.update);
    expect(checkDocUpdate(new Uint8Array([...real, 0]), 'push')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('struct headers: only the forms every Yjs reader agrees on', () => {
  test('the review’s 7 bytes (info 0x4a: a Skip to applyUpdate, an Item with content ref 10 to mergeUpdates) → refused as a push and a seed', () => {
    const update = new Uint8Array([0x01, 0x01, 0x01, 0x00, 0x4a, 0x01, 0x00]);
    expect(() => Y.mergeUpdates([bytes(EDITOR_SEED), update])).toThrow();
    expect(checkDocUpdate(update, 'push')).toEqual({ ok: false, reason: 'malformed' });
    expect(checkDocUpdate(update, 'seed')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('a GC or Skip byte with any flag bit set (low bits 0 or 10, info not exactly 0 or 10) → refused', () => {
    for (const info of [0x20, 0x40, 0x80, 0x2a, 0x8a, 0xca]) {
      const update = new V1().uint(1).uint(1).uint(CLIENT).uint(0).byte(info).uint(1).uint(0).done();
      expect({ info, check: checkDocUpdate(update, 'seed') }).toEqual({ info, check: { ok: false, reason: 'malformed' } });
    }
  });

  test('a canonical GC (info 0) and Skip (info 10) still pass and merge', () => {
    const update = new V1().uint(1).uint(3).uint(CLIENT).uint(0).byte(0).uint(2).byte(10).uint(3).byte(0).uint(1).uint(0).done();
    expect(checkDocUpdate(update, 'push')).toEqual({ ok: true });
    expect(() => Y.mergeUpdates([bytes(EDITOR_SEED), update])).not.toThrow();
  });
});

describe('the scan never accepts what Yjs cannot read', () => {
  /** Where the first struct's info byte sits: after the client count, struct count, client and clock. */
  function firstInfoAt(update: Uint8Array): number {
    let pos = 0;
    for (let field = 0; field < 4; field++) while (update[pos++]! >= 0x80);
    return pos;
  }

  test('20,000 inputs (every value of the first struct header of each recorded update, then random flips): each one accepted decodes, merges with the seed, and applies to a doc built from the seed', () => {
    const seed = bytes(EDITOR_SEED);
    const real = [seed, ...EDITOR_PUSHES.map((p) => bytes(p.update))];
    const inputs: Uint8Array[] = [];
    for (const update of real) {
      if (update.length < 6) continue;
      const at = firstInfoAt(update);
      for (let value = 0; value < 256; value++) {
        const mutated = update.slice();
        mutated[at] = value;
        inputs.push(mutated);
      }
    }
    let state = 42;
    const rand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    const HEADER_LIKE = [0, 10, 0x4a, 0x8a, 0x20, 0x40, 0x80, 0x84, 0x44, 0x24, 0x87, 0x88, 0x06, 0x07, 0x08, 0x01];
    while (inputs.length < 20_000) {
      const i = inputs.length;
      if (i % 10 === 9) {
        inputs.push(new Uint8Array(Array.from({ length: 8 + (rand() % 64) }, () => rand() & 0xff)));
        continue;
      }
      const mutated = real[i % real.length]!.slice();
      for (let k = 0; k < 1 + (rand() % 3); k++) {
        const at = rand() % mutated.length;
        mutated[at] = i % 2 === 0 ? HEADER_LIKE[rand() % HEADER_LIKE.length]! : rand() & 0xff;
      }
      inputs.push(mutated);
    }
    let accepted = 0;
    const failures: string[] = [];
    for (const input of inputs) {
      if (!checkDocUpdate(input, 'seed').ok) continue;
      accepted += 1;
      try {
        Y.decodeUpdate(input);
        Y.mergeUpdates([seed, input]);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, seed);
        Y.applyUpdate(doc, input);
        doc.destroy();
      } catch (error) {
        if (failures.length < 5) failures.push(`${Buffer.from(input).toString('base64')}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(inputs.length).toBe(20_000);
    expect(accepted).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  }, 60_000);
});
