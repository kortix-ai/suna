import { describe, expect, test } from 'bun:test';

import { GENUI_MAX_NODES } from './catalog';
import { createGenuiParser, parseGenui } from './parse';
import { HOTEL } from './test-fixtures';

describe('parse + validate', () => {
  test('a valid block renders the whole tree with stable ids', () => {
    const { root, issues } = parseGenui(HOTEL);
    expect(issues).toEqual([]);
    expect(root?.type).toBe('Stack');
    const children = root?.props.children as { id: string; type: string }[];
    expect(children.map((c) => `${c.id}:${c.type}`)).toEqual(['stats:StatRow', 'list:RankedList', 'tip:Callout']);
  });

  test('duplicate references get unique ids', () => {
    const { root } = parseGenui('root = Stack([r])\nr = StatRow([a, a])\na = Stat("x", "1")');
    const stats = ((root?.props.children as { props: { stats: { id: string }[] } }[])[0]!).props.stats;
    expect(stats.map((s) => s.id)).toEqual(['a', 'a#1']);
  });

  test('drops javascript: links but keeps siblings', () => {
    const { root, issues } = parseGenui('root = Stack([bad, ok])\nbad = Link("x", "javascript:alert(1)")\nok = Badge("fine")');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toEqual(['url']);
  });

  test('an unsafe optional URL removes only that prop', () => {
    const { root } = parseGenui('root = Stack([c])\nc = Card("Title", "Body", null, "javascript:x")');
    const card = (root?.props.children as { props: Record<string, unknown> }[])[0]!;
    expect(card.props.title).toBe('Title');
    expect(card.props.image).toBeUndefined();
  });

  test('enforces limits lang-core skips', () => {
    const long = parseGenui(`root = Stack([n])\nn = Callout("info", "${'x'.repeat(401)}")`);
    // The only child fails, so the root Stack (min 1 child) fails too: the block renders its fallback.
    expect(long.root).toBeNull();
    expect(long.issues.map((i) => `${i.code}:${i.component}`)).toEqual(['schema:Callout', 'schema:Stack', 'no-root:undefined']);
    const many = parseGenui('root = Stack([r, ok])\nr = StatRow([a, a, a, a, a])\na = Stat("x", "1")\nok = Badge("kept")');
    expect((many.root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
  });

  test('rejects a component in the wrong slot', () => {
    const { root, issues } = parseGenui('root = Stack([s, ok])\ns = Series("x", [1])\nok = Badge("kept")');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('wrong-child');
  });

  test('limits nesting depth to 4 containers', () => {
    const deep = 'root = Stack([a])\na = Stack([b])\nb = Stack([c])\nc = Stack([d])\nd = Stack([e])\ne = Badge("x")';
    const { issues } = parseGenui(deep);
    expect(issues.map((i) => i.code)).toContain('depth');
  });

  test('a block with no root reports no-root', () => {
    expect(parseGenui('a = Badge("x")').issues.map((i) => i.code)).toContain('no-root');
  });

  test('after the stream ends, an unfinished statement is dropped as cut-off; siblings stay', () => {
    const { root, issues } = parseGenui('root = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "unfinish');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('cut-off');
  });

  test('Query, Mutation, and $state are recorded and never become nodes', () => {
    const { root, issues } = parseGenui('root = Stack([b])\nb = Badge("x")\n$tab = "a"\nq = Query("tool", {})');
    expect((root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Badge']);
    expect(issues.map((i) => i.code)).toContain('unsupported-statement');
  });

  test('a newer version is unsupported, not parsed', () => {
    expect(parseGenui(HOTEL, 2).issues.map((i) => i.code)).toEqual(['version']);
  });

  test('streaming: root appears first, children fill in, same input returns same object', () => {
    const parser = createGenuiParser();
    const early = parser.update(HOTEL.slice(0, 40), true);
    expect(early.root?.type).toBe('Stack');
    expect(early.pending.length).toBeGreaterThan(0);
    const again = parser.update(HOTEL.slice(0, 40), true);
    expect(again).toBe(early);
    const done = parser.update(HOTEL, false);
    expect(done.pending).toEqual([]);
    expect((done.root?.props.children as unknown[]).length).toBe(3);
  });

  test('mid-string ticks mark only the statement being written as partial', () => {
    // lang-core flags every node partial when the input ends inside a string; Kortix must not.
    const parser = createGenuiParser();
    const result = parser.update('root = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "half a sente', true);
    const children = result.root?.props.children as { id: string; partial: boolean }[];
    expect(result.root?.partial).toBe(false);
    expect(children.map((c) => `${c.id}:${c.partial}`)).toEqual(['a:false', 'b:true']);
  });

  test('streaming relaxes slot minimums, the final parse enforces them', () => {
    const partial = 'root = Stack([r, ok])\nr = StatRow([a, b])\na = Stat("x", "1")\nok = Badge("kept")';
    const parser = createGenuiParser();
    const types = (result: ReturnType<typeof parser.update>) =>
      (result.root?.props.children as { type: string }[]).map((c) => c.type);
    expect(types(parser.update(partial, true))).toEqual(['StatRow', 'Badge']);
    expect(types(parser.update(partial, false))).toEqual(['Badge']);
  });

  test('parse cost: a 4 KB block streamed in 64-byte ticks stays under 2 ms per tick', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `["Row ${i} with a longer descriptive label", ${i}, "an extra column of note text"]`).join(', ');
    const big = `root = Stack([t, c])\nt = Table(["Name", "Value", "Note"], [${rows}])\nc = BarChart(["a","b","c"], [s], "test data")\ns = Series("S", [1,2,3])\n${HOTEL.split('\n').slice(1).join('\n')}`;
    const parser = createGenuiParser();
    const started = performance.now();
    let ticks = 0;
    for (let i = 64; i < big.length + 64; i += 64) {
      parser.update(big.slice(0, i), true);
      ticks++;
    }
    const perTick = (performance.now() - started) / ticks;
    expect(big.length).toBeGreaterThan(4000);
    expect(perTick).toBeLessThan(2);
  });

  test('reference fan-out is capped by the node budget', () => {
    const twelve = (name: string) => Array.from({ length: 12 }, () => name).join(', ');
    const block = `root = Stack([${twelve('a')}])\na = Stack([${twelve('b')}])\nb = Stack([${twelve('c')}])\nc = Badge("x")`;
    const started = performance.now();
    const result = parseGenui(block);
    const elapsed = performance.now() - started;
    const count = (node: { props: Record<string, unknown> } | null): number =>
      node === null
        ? 0
        : 1 + ((node.props.children as { props: Record<string, unknown> }[] | undefined) ?? []).reduce((sum, child) => sum + count(child), 0);
    expect(count(result.root)).toBeLessThanOrEqual(GENUI_MAX_NODES);
    expect(result.issues.filter((issue) => issue.code === 'too-many-nodes')).toHaveLength(1);
    expect(elapsed).toBeLessThan(50);
  });
});
