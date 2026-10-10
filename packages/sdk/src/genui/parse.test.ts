import { describe, expect, test } from 'bun:test';

import { GENUI_MAX_NODES, GENUI_MAX_SOURCE_CHARS } from './catalog';
import { genuiBlockToMarkdown } from './markdown';
import { createGenuiParser, parseGenui } from './parse';
import { BROKEN_TABS, HOTEL } from './test-fixtures';

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
    // The StatRow (max 4) fails; its 5 valid Stats are blocks, so they take its place in the Stack.
    expect((many.root?.props.children as { type: string }[]).map((c) => c.type)).toEqual(['Stat', 'Stat', 'Stat', 'Stat', 'Stat', 'Badge']);
  });

  test('Map takes zoom before route: Map(markers, source, zoom?, route?)', () => {
    const { root, issues } = parseGenui(
      'root = Stack([m])\nm = Map([p], "src", 12, [[1, 2], [3, 4]])\np = Marker(1, 2, "A")',
    );
    expect(issues).toEqual([]);
    const map = (root?.props.children as { type: string; props: Record<string, unknown> }[])[0]!;
    expect(map.type).toBe('Map');
    expect(map.props.zoom).toBe(12);
    expect(map.props.route).toEqual([[1, 2], [3, 4]]);
  });

  test('Stat delta allows 24 characters and rejects 25', () => {
    const stat = (delta: string) => parseGenui(`root = Stack([s])\ns = Stat("Open rate", "31%", "${delta}")`);
    expect(stat('x'.repeat(24)).issues).toEqual([]);
    expect(stat('x'.repeat(25)).issues.map((i) => i.code)).toContain('schema');
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
    // The final parse fails the StatRow (min 2); its one valid Stat takes its place.
    expect(types(parser.update(partial, false))).toEqual(['Stat', 'Badge']);
  });

  test('parse cost: a 4 KB block streamed in 64-byte ticks stays under 2 ms per tick', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `["Row ${i} with a longer descriptive label", ${i}, "an extra column of note text"]`).join(', ');
    const big = `root = Stack([t, c])\nt = Table(["Name", "Value", "Note"], [${rows}])\nc = BarChart(["a","b","c"], [s], "test data")\ns = Series("S", [1,2,3])\n${HOTEL.split('\n').slice(1).join('\n')}`;
    // Best of 3 streamed passes: one cold pass includes JIT warm-up and GC
    // pauses (measured 0.1-1.2 ms alone, up to 3.4 ms beside other suites).
    const streamOnce = () => {
      const parser = createGenuiParser();
      const started = performance.now();
      let ticks = 0;
      for (let i = 64; i < big.length + 64; i += 64) {
        parser.update(big.slice(0, i), true);
        ticks++;
      }
      return (performance.now() - started) / ticks;
    };
    const perTick = Math.min(streamOnce(), streamOnce(), streamOnce());
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

type Tree = { id: string; type: string; props: Record<string, unknown> };
const kids = (node: Tree | null | undefined, slot = 'children') => (node?.props[slot] ?? []) as Tree[];

describe('salvage: a node that fails its schema gives up its valid subtrees', () => {
  test('failures that cascade to the root keep the valid Tables, in source order', () => {
    const { root, issues } = parseGenui(BROKEN_TABS);
    expect(root?.id).toBe('root');
    expect(kids(root).map((c) => `${c.id}:${c.type}`)).toEqual(['a:Table', 'b:Table', 'c:Table']);
    expect(issues.map((i) => `${i.code}:${i.statementId}`)).toEqual(['schema:note', 'schema:t1', 'schema:t2', 'schema:tabs']);
    const markdown = genuiBlockToMarkdown(BROKEN_TABS);
    for (const value of ['| 1 |', '| 2 |', '| 3 |']) expect(markdown).toContain(value);
  });

  test('a root that fails becomes a Stack of its valid subtrees', () => {
    const names = Array.from({ length: 13 }, (_, i) => `b${i}`);
    const block = [`root = Stack([${names.join(', ')}])`, ...names.map((name) => `${name} = Badge("${name}")`)].join('\n');
    const { root, issues } = parseGenui(block);
    expect(root?.type).toBe('Stack');
    expect(kids(root).map((c) => c.id)).toEqual(names);
    expect(issues.map((i) => `${i.code}:${i.statementId}`)).toEqual(['schema:root']);
  });

  test('a root with no valid subtree stays null', () => {
    const { root, issues } = parseGenui(`root = Stack([n])\nn = Callout("info", "${'x'.repeat(401)}")`);
    expect(root).toBeNull();
    expect(issues.map((i) => i.code)).toEqual(['schema', 'schema', 'no-root']);
  });

  test('a failed node inside a valid parent: what the parent cannot hold rises to an ancestor that can', () => {
    const block = `root = Stack([tabs, end])
tabs = Tabs([t1, t2, t3])
t1 = Tab("One", [a])
t2 = Tab("${'L'.repeat(31)}", [b])
t3 = Tab("Three", [c])
a = Badge("a")
b = Table(["k"], [["2"]])
c = Badge("c")
end = Badge("end")`;
    const { root, issues } = parseGenui(block);
    expect(kids(root).map((c) => `${c.id}:${c.type}`)).toEqual(['tabs:Tabs', 'b:Table', 'end:Badge']);
    expect(kids(kids(root)[0], 'tabs').map((t) => t.id)).toEqual(['t1', 't3']);
    expect(issues.map((i) => `${i.code}:${i.statementId}`)).toEqual(['schema:t2']);
  });

  test('a valid child the parent slot does not accept gives up its own children', () => {
    const tabs = Array.from({ length: 6 }, (_, i) => `t${i}`);
    const block = [
      'root = Stack([tabs])',
      `tabs = Tabs([${tabs.join(', ')}])`,
      ...tabs.map((t, i) => `${t} = Tab("Tab ${i}", [b${i}])\nb${i} = Badge("${i}")`),
    ].join('\n');
    const { root, issues } = parseGenui(block);
    expect(kids(root).map((c) => c.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(issues.map((i) => `${i.code}:${i.statementId}`)).toEqual(['schema:tabs']);
  });

  test('salvaged subtrees keep their limits: an unsafe URL is still removed', () => {
    const block = `root = Stack([tabs])
tabs = Tabs([t1, t2])
t1 = Tab("${'L'.repeat(31)}", [card])
t2 = Tab("Two", [x])
card = Card("Title", "Body", null, "javascript:x")
x = Badge("x")`;
    const { root, issues } = parseGenui(block);
    expect(kids(root).map((c) => `${c.id}:${c.type}`)).toEqual(['card:Card', 'x:Badge']);
    expect(kids(root)[0]!.props.image).toBeUndefined();
    expect(issues.map((i) => `${i.code}:${i.statementId}`)).toEqual(['url:card', 'schema:t1', 'schema:tabs']);
  });

  test('streaming: a salvaged subtree keeps its object identity across ticks', () => {
    const parser = createGenuiParser();
    const upTo = BROKEN_TABS.indexOf('c = Table');
    const first = parser.update(BROKEN_TABS.slice(0, upTo), true);
    const next = parser.update(BROKEN_TABS.slice(0, upTo + 4), true);
    const tableA = (result: typeof first) => kids(result.root).find((c) => c.id === 'a');
    expect(tableA(first)).toBeDefined();
    expect(tableA(next)).toBe(tableA(first)!);
    const done = parser.update(BROKEN_TABS, false);
    expect(kids(done.root).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});

/** `levels` statements, each a Stack of 12 references to the next: 12^levels nodes once expanded. */
const fanOut = (levels: number): string => {
  const twelve = (name: string) => Array.from({ length: 12 }, () => name).join(', ');
  const lines = [`root = Stack([${twelve('n0')}])`];
  for (let i = 0; i < levels - 1; i++) lines.push(`n${i} = Stack([${twelve(`n${i + 1}`)}])`);
  lines.push(`n${levels - 1} = Badge("x")`);
  return lines.join('\n');
};

describe('adversarial input', () => {
  // Generous bounds: before the pre-scan, level 6 took ~2.5 s and level 7 never finished.
  test('reference fan-out at levels 5 to 8 is rejected before lang-core expands it', () => {
    const started = performance.now();
    for (const levels of [5, 6, 7, 8]) {
      const block = fanOut(levels);
      expect(block.length).toBeLessThan(600);
      const result = parseGenui(block);
      expect(result.root).toBeNull();
      expect(result.issues.map((issue) => issue.code)).toEqual(['too-many-nodes']);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('fan-out is rejected on every streaming tick too', () => {
    const block = fanOut(7);
    const parser = createGenuiParser();
    const started = performance.now();
    for (let i = 16; i < block.length + 16; i += 16) parser.update(block.slice(0, i), true);
    const done = parser.update(block, false);
    expect(done.issues.map((issue) => issue.code)).toEqual(['too-many-nodes']);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('deep nesting never throws: 5,000 levels is a depth issue, 20,000 (180 KB) is too large', () => {
    const nested = (levels: number) => `root = ${'Stack(['.repeat(levels)}Badge("x")${'])'.repeat(levels)}`;
    const deep = parseGenui(nested(5_000));
    expect(deep.root).toBeNull();
    expect(deep.issues.map((issue) => issue.code)).toEqual(['depth']);
    expect(parseGenui(nested(20_000)).issues.map((issue) => issue.code)).toEqual(['too-large']);
  });

  test('a long chain of references is rejected as too deep', () => {
    const lines = ['root = Stack([a0])'];
    for (let i = 0; i < 2_000; i++) lines.push(`a${i} = a${i + 1}`);
    lines.push('a2000 = Badge("x")');
    const result = parseGenui(lines.join('\n'));
    expect(result.root).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(['depth']);
  });

  test(`a block over GENUI_MAX_SOURCE_CHARS (${GENUI_MAX_SOURCE_CHARS}) is not parsed`, () => {
    const started = performance.now();
    const result = parseGenui(`root = Stack([c])\nc = Callout("info", "${'a'.repeat(1_000_000)}")`);
    expect(result.root).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toEqual(['too-large']);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('legitimate nesting at the container limit still parses', () => {
    const block =
      'root = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [s])\ny = Tab("Two", [b])\ns = Stack([c])\nc = Table(["a", "b"], [[1, 2], [3, 4]])\nb = Badge("x")';
    const { root, issues } = parseGenui(block);
    expect(issues).toEqual([]);
    expect(root?.type).toBe('Stack');
  });

  test('many $state statements that reference one large data statement are rejected', () => {
    // leaf: 1 value; row: 1 + 40 refs + 40 x 1 = 81; table: 1 + 590 refs + 590 x 81 = 48,381 values.
    const lines = ['root = Stack([b])', 'b = Badge("x")', 'leaf = "v"'];
    lines.push(`row = [${Array.from({ length: 40 }, () => 'leaf').join(', ')}]`);
    lines.push(`table = [${Array.from({ length: 590 }, () => 'row').join(', ')}]`);
    for (let i = 0; i < 1_000; i++) lines.push(`$v${i} = table`);
    const started = performance.now();
    const result = parseGenui(lines.join('\n'));
    expect(result.issues.map((issue) => issue.code)).toEqual(['too-many-nodes']);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('a block with ordinary $state statements still parses', () => {
    const code = 'root = Stack([t])\nt = Tabs([x, y])\nx = Tab("One", [b1])\ny = Tab("Two", [b2])\nb1 = Badge("first")\nb2 = Badge("second")\n$tab = "One"\n$open = false\n$items = ["a", "b"]';
    const { root, issues } = parseGenui(code);
    expect(root?.type).toBe('Stack');
    expect(issues.map((issue) => issue.code)).toEqual(['unsupported-statement']);
  });

  test('the issue list is capped at 50, first issues kept', () => {
    const children = Array.from({ length: 12 }, (_, i) => `s${i}`).join(', ');
    const lines = [`root = Stack([${children}, ok])`, 'ok = Badge("kept")'];
    // 12 statements x 6 unknown components: 72 issues before the cap.
    for (let i = 0; i < 12; i++) lines.push(`s${i} = Stack([${Array.from({ length: 6 }, () => 'Nope("x")').join(', ')}])`);
    const { issues } = parseGenui(lines.join('\n'));
    expect(issues.length).toBe(50);
    expect(issues[0]?.code).toBe('unknown-component');
  });

  test('the cap never drops a cut-off issue: the settled cut-off note depends on it', () => {
    const children = Array.from({ length: 12 }, (_, i) => `s${i}`).join(', ');
    const lines = [`root = Stack([${children}, ok, c])`, 'ok = Badge("kept")'];
    for (let i = 0; i < 12; i++) lines.push(`s${i} = Stack([${Array.from({ length: 6 }, () => 'Nope("x")').join(', ')}])`);
    lines.push('c = Callout("info", "unfin');
    const code = lines.join('\n');
    const { issues } = parseGenui(code);
    expect(issues.length).toBeLessThanOrEqual(51);
    expect(issues.filter((issue) => issue.code === 'cut-off')).toHaveLength(1);
    expect(genuiBlockToMarkdown(code)).toBe('[kept]\n\n*Response was cut off.*');
  });
});

/**
 * Fan-out hidden from a pre-scan that splits statements differently from lang-core. Each shape
 * builds `levels` statements, each a container of 12 references to the next.
 */
const twelve = (name: string) => Array.from({ length: 12 }, () => name).join(', ');
const chain = (levels: number, define: (id: string, body: string) => string): string[] => {
  const lines: string[] = [];
  for (let i = 0; i < levels - 1; i++) lines.push(define(`p${i}`, `Stack([${twelve(`p${i + 1}`)}])`));
  lines.push(define(`p${levels - 1}`, 'Badge("leaf")'));
  return lines;
};
const top = `root = Stack([${twelve('p0')}])`;
const plain = (id: string, body: string) => `${id} = ${body}`;
const HIDDEN_FAN_OUT: Record<string, (levels: number) => string> = {
  'a # comment holding a quote': (l) => [`${top} # it's here`, ...chain(l, plain)].join('\n'),
  'a // comment holding a bracket': (l) => [`${top} // note (open`, ...chain(l, plain)].join('\n'),
  'punctuation lang-core skips after the id': (l) => [top, ...chain(l, (id, body) => `${id} ; = ${body}`)].join('\n'),
  'a non-ASCII letter after the id': (l) => [top, ...chain(l, (id, body) => `${id}\u00fc = ${body}`)].join('\n'),
  'a carriage return after the id': (l) => [top, ...chain(l, (id, body) => `${id}\r = ${body}`)].join('\n'),
  'an inner fence lang-core strips': (l) => ['w = [', '```', top, ...chain(l, plain), '```'].join('\n'),
  'a junk line that opens a bracket': (l) => [top, 'junk junk = Stack([', ...chain(l, plain), '])'].join('\n'),
  'ternary continuation lines': (l) => {
    const lines: string[] = [];
    for (let i = 0; i < l - 1; i++) lines.push(`p${i} = flag\n  ? Stack([${twelve(`p${i + 1}`)}])\n  : Stack([${twelve(`p${i + 1}`)}])`);
    return [top, ...lines, `p${l - 1} = Badge("leaf")`, 'flag = true'].join('\n');
  },
  'a duplicated id inside an incomplete pending tail': (l) => {
    // The junk line leaves a bracket open, so every later line is one incomplete pending tail.
    // Each statement is written small, then heavy: lang-core keeps the later definition.
    const lines = [top, 'junk junk = Stack(['];
    for (let i = 0; i < l - 1; i++) lines.push(`p${i} = Badge("small")`, `p${i} = Stack([${twelve(`p${i + 1}`)}])`);
    return [...lines, `p${l - 1} = Badge("leaf")`].join('\n');
  },
  'a redefinition still streaming': (l) => [top, ...chain(l, plain), 'p0 = Badge("unfinish'].join('\n'),
  'a reference cycle beside the fan-out': (l) => {
    // q_i and r_i reference each other; r_i also fans out to r_(i-1).
    const lines = [`root = Stack([${Array.from({ length: l }, (_, i) => `q${i}`).join(', ')}, ${twelve(`r${l - 1}`)}])`];
    for (let i = 0; i < l; i++) {
      lines.push(`q${i} = Stack([r${i}, ${i > 0 ? twelve(`r${i - 1}`) : 'leaf'}])`);
      lines.push(`r${i} = Stack([${twelve(`q${i}`)}])`);
    }
    return [...lines, 'leaf = Badge("x")'].join('\n');
  },
  'data fan-out with no components': (l) => {
    const lines = ['root = Stack([t])', 't = Table(["a"], [[d0]])'];
    for (let i = 0; i < l - 1; i++) lines.push(`d${i} = [${twelve(`d${i + 1}`)}]`);
    return [...lines, `d${l - 1} = "v"`].join('\n');
  },
};

describe('hidden fan-out (statements split exactly as lang-core splits them)', () => {
  for (const [shape, build] of Object.entries(HIDDEN_FAN_OUT)) {
    test(`${shape}: levels 6 to 8 are rejected before lang-core expands them`, () => {
      const started = performance.now();
      for (const levels of [6, 7, 8]) {
        const result = parseGenui(build(levels));
        expect(result.root).toBeNull();
        expect(result.issues.map((issue) => issue.code)).toEqual(['too-many-nodes']);
      }
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  }

  test('many references to a data statement are not component nodes', () => {
    // 12 Stats x 2 references to one text statement: 24 references, 13 components.
    const stats = Array.from({ length: 4 }, (_, i) => `s${i}`).join(', ');
    const lines = [`root = Stack([${Array.from({ length: 3 }, (_, i) => `row${i}`).join(', ')}])`];
    for (let r = 0; r < 3; r++) lines.push(`row${r} = StatRow([${stats}])`);
    for (let i = 0; i < 4; i++) lines.push(`s${i} = Stat(label, value)`);
    lines.push('label = "Users"', 'value = "900"');
    const { root, issues } = parseGenui(lines.join('\n'));
    expect(issues).toEqual([]);
    expect((root?.props.children as unknown[]).length).toBe(3);
  });
});

