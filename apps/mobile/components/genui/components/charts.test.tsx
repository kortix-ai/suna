/**
 * The generative-UI chart card: header row, legend, plot, Show data sheet, and the six pie layouts.
 * Nodes come from real OpenUI source through the SDK parser; React Native, svg, and the sheet are host
 * stubs, so the assertions read what the chart hands to them. Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style ?? {}) as Record<string, unknown>);

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s },
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
}));
mock.module('react-native-svg', () => ({ default: host('svg'), G: host('svg-g'), Path: host('svg-path') }));
// `lib/utils/theme` builds NAV_THEME from React Navigation's themes, which do not load under Bun.
mock.module('expo-router/react-navigation', () => ({ DefaultTheme: {}, DarkTheme: {} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
const translate = (_key: string, options: string | Record<string, unknown>) =>
  typeof options === 'string'
    ? options
    : String(options.defaultValue).replace(/{{(\w+)}}/g, (_m, name: string) => String(options[name]));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/separator', () => ({ Separator: host('separator') }));
// `layout.tsx` pulls in gesture handler and the markdown stack; the chart needs only its `kids`.
mock.module('./layout', () => ({ kids: (value: unknown) => (Array.isArray(value) ? value : []) }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetScrollView: host('sheet-scroll') }));
/** The sheet renders its content only once presented, as gorhom's modal does. */
mock.module('@/components/kortix/sheet', () => ({
  KortixBottomSheetModal: React.forwardRef(({ children, ...props }: HostProps, ref) => {
    const [open, setOpen] = React.useState(false);
    React.useImperativeHandle(ref, () => ({ present: () => setOpen(true) }));
    return open ? React.createElement('sheet', props, children) : null;
  }),
}));

let GenuiChart: typeof import('./charts').GenuiChart;
let parseGenui: typeof import('@kortix/sdk/genui').parseGenui;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GenuiChart } = await import('./charts'));
  ({ parseGenui } = await import('@kortix/sdk/genui'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

function render(code: string) {
  const node = (parseGenui(code).root!.props.children as { props: Record<string, unknown> }[])[0]!;
  act(() => {
    tree = create(<GenuiChart node={node as never} props={node.props as never} renderChild={() => null} streaming={false} />);
  });
  return tree!.root;
}

function texts(node: ReactTestInstance): string[] {
  const out: string[] = [];
  const walk = (n: ReactTestInstance | string) => {
    if (typeof n === 'string') return void out.push(n);
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}
const all = (root: ReactTestInstance, type: string) => root.findAll((n) => n.type === (type as never));
const press = (n: ReactTestInstance) => act(() => (n.props.onPress as () => void)());
const showData = (root: ReactTestInstance) =>
  all(root, 'pressable').find((n) => n.props.accessibilityRole === 'button' && texts(n).includes('Show data'))!;
/** The plot: the host that measures itself (a Pressable, so a tap reads a value). */
const plot = (root: ReactTestInstance) => root.findAll((n) => typeof n.type === 'string' && typeof n.props.onLayout === 'function')[0]!;
const layOut = (root: ReactTestInstance, width: number) => act(() => plot(root).props.onLayout({ nativeEvent: { layout: { width } } }));
const tap = (n: ReactTestInstance, x: number) => act(() => n.props.onPress({ nativeEvent: { locationX: x } }));

const BARS = `root = Stack([c])
c = BarChart(["Q1", "Q2"], [rev, cost], "billing export", "USD")
rev = Series("Revenue", [1200, 900])
cost = Series("Cost", [400, 500])`;
const COSTS: readonly (readonly [string, number])[] = [['Compute', 4200], ['Storage', 1800], ['Network', 900], ['Other', 300]];
const pie = (variant: string | null, slices: readonly (readonly [string, number])[] = COSTS) =>
  `root = Stack([p])\np = PieChart([${slices.map((_, i) => `s${i}`).join(', ')}], "cost report", "USD"${variant ? `, "${variant}"` : ''})\n` +
  slices.map(([label, value], i) => `s${i} = Slice("${label}", ${value})`).join('\n');

describe('mobile genui chart', () => {
  test('the header row comes first: the source and unit as the title, then Show data; the legend sits under it, above the plot', () => {
    const root = render(BARS);
    const shown = texts(root);
    expect(shown.slice(0, 2)).toEqual(['billing export · USD', 'Show data']);
    expect(shown.indexOf('Revenue')).toBeGreaterThan(shown.indexOf('Show data'));
    expect(shown.indexOf('Cost')).toBeLessThan(shown.indexOf('Q1'));
    // No "Source:" line under the chart; the screen-reader text keeps it.
    expect(shown.some((text) => text.startsWith('Source'))).toBe(false);
    const figure = root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'image');
    expect(figure.map((n) => n.props.accessibilityLabel)).toEqual(['Bar chart: Revenue, Cost. Source: billing export']);
  });

  test('legend swatches are rounded squares in the series colors', () => {
    const root = render(BARS);
    const swatches = all(root, 'view').filter((n) => String(n.props.className ?? '') === 'size-2.5 rounded-sm');
    expect(swatches.map((n) => flatten(n.props.style).backgroundColor)).toEqual(['hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)']);
  });

  test('Show data opens a sheet with every value; the card shows none of them before', () => {
    const root = render(BARS);
    expect(all(root, 'sheet')).toHaveLength(0);
    expect(texts(root)).not.toContain('1,200');
    press(showData(root));
    const sheet = all(root, 'sheet')[0]!;
    expect(sheet.props.title).toBe('Show data');
    for (const value of ['1,200', '900', '400', '500', 'Revenue (USD)']) expect(texts(sheet)).toContain(value);
  });

  test('after layout, bars draw on the brand chart ramp with the max value labelled', () => {
    const root = render(BARS);
    layOut(root, 300);
    const fills = all(root, 'svg-path').map((n) => n.props.fill).filter(Boolean);
    expect(fills).toEqual(['hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)', 'hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)']);
    expect(texts(root)).toContain('1,200 USD');
  });

  test('a pie has no series legend row and defaults to a gauge for two slices, a donut for more', () => {
    const two = render(pie(null, [['Used', 68], ['Left', 32]]));
    // gauge: a half-height svg (a 200pt-wide half ring) and an inline legend with shares.
    expect(all(two, 'svg').map((n) => n.props.height)).toEqual([100]);
    expect(texts(two)).toEqual(expect.arrayContaining(['Used 68%', 'Left 32%']));
    act(() => tree!.unmount());
    const four = render(pie(null));
    // donut: the total in the center, a row per slice with its value and share.
    expect(texts(four)).toEqual(expect.arrayContaining(['7,200', 'Compute', '4,200', '58%']));
    expect(all(four, 'svg').map((n) => n.props.height)).toEqual([168]);
  });

  test('focus paints the first slice in the brand accent and states its share', () => {
    const root = render(pie('focus'));
    expect(texts(root)).toContain('Compute is 58% of the total');
    expect(texts(root)).toContain('4,200 of 7,200 USD');
    const fills = all(root, 'svg-path').map((n) => n.props.fill);
    expect(fills[0]).toBe('hsla(210, 93%, 56.9%, 1)');
  });

  test('treemap: a block too small for text shows none; a tap on any block shows its data', () => {
    const root = render(pie('treemap'));
    const blocks = all(root, 'pressable').filter((n) => String(n.props.accessibilityLabel ?? '').includes('%'));
    expect(blocks.map((n) => n.props.accessibilityLabel)).toEqual([
      'Compute: 4,200 USD (58%)',
      'Storage: 1,800 USD (25%)',
      'Network: 900 USD (13%)',
      'Other: 300 USD (4%)',
    ]);
    // Other is 10% of the right column (300 of 3,000): no room for text.
    const other = blocks[3]!;
    expect(texts(other)).toEqual([]);
    expect(texts(blocks[1]!)).toEqual(['Storage', '25%']);
    press(other);
    expect(texts(root)).toEqual(expect.arrayContaining(['Other', '300 USD · 4%']));
  });

  test('stack and ring list every slice with its value', () => {
    const stack = render(pie('stack'));
    expect(texts(stack)).toEqual(expect.arrayContaining(['Compute', '4,200 · 58%', 'Other', '300 · 4%']));
    act(() => tree!.unmount());
    const ring = render(pie('ring'));
    // The ring's center is the largest share.
    expect(texts(ring)).toEqual(expect.arrayContaining(['58%', 'Compute', '1,800']));
    expect(all(ring, 'separator')).toHaveLength(3);
  });

  test('series 3 is the theme ink, between the two ramp steps and --chart-1', () => {
    const root = render(`root = Stack([c])
c = BarChart(["Q1"], [a, b, d, e], "billing export")
a = Series("A", [1])
b = Series("B", [2])
d = Series("C", [3])
e = Series("D", [4])`);
    layOut(root, 300);
    const fills = all(root, 'svg-path').map((n) => n.props.fill).filter(Boolean);
    expect(fills).toEqual(['hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)', 'hsla(0, 0%, 12.2%, 1)', 'hsla(47, 100%, 59.4%, 1)']);
  });

  test('an all-zero chart shows no made-up axis max', () => {
    const root = render(`root = Stack([c])
c = BarChart(["Q1", "Q2"], [s], "billing export", "USD")
s = Series("Revenue", [0, 0])`);
    // Only the title carries the unit; no "1 USD" max label.
    expect(texts(root).filter((text) => text.endsWith(' USD'))).toEqual(['billing export · USD']);
  });

  test('Show data keeps values past the last label, in rows numbered by position', () => {
    const root = render(`root = Stack([c])
c = BarChart(["Q1"], [s], "billing export")
s = Series("Revenue", [10, 20, 30])`);
    press(showData(root));
    const shown = texts(all(root, 'sheet')[0]!);
    for (const text of ['Q1', '10', '2', '20', '3', '30']) expect(shown).toContain(text);
  });

  test('a pie share treats a negative value as 0, as the slices do', () => {
    // The SDK schema rejects a negative slice, so the node is built by hand: the renderer still must not show one.
    const node = {
      id: 'p',
      type: 'PieChart',
      props: { source: 'survey', slices: [
        { id: 'a', type: 'Slice', props: { label: 'Yes', value: 3 } },
        { id: 'b', type: 'Slice', props: { label: 'No', value: -1 } },
      ] },
    };
    act(() => {
      tree = create(<GenuiChart node={node as never} props={node.props as never} renderChild={() => null} streaming={false} />);
    });
    expect(texts(tree!.root)).toEqual(expect.arrayContaining(['Yes 100%', 'No 0%']));
  });

  test('a single-series line names its series in the legend and labels the ends of its x axis', () => {
    const root = render(`root = Stack([c])
c = LineChart(["Mon", "Tue", "Wed"], [s], "app logs")
s = Series("Visits", [3, 5, 4])`);
    layOut(root, 300);
    expect(texts(root)).toEqual(expect.arrayContaining(['Visits', 'Mon', 'Wed']));
    expect(texts(root)).not.toContain('Tue');
    expect(all(root, 'svg-path').filter((n) => n.props.fill === 'none')).toHaveLength(1);
  });

  test('a donut draws one slice per non-zero value and names each slice with its share', () => {
    const root = render(pie(null, [['Yes', 3], ['No', 1], ['Unsure', 0]]));
    expect(all(root, 'svg-path')).toHaveLength(2);
    expect(texts(root)).toEqual(expect.arrayContaining(['Yes', '75%', 'No', '25%', 'Unsure', '0%']));
  });

  test('a tap on a bar group reads its values above the plot and dims the other bars; a second tap clears it', () => {
    const root = render(BARS);
    layOut(root, 302);
    tap(plot(root), 250);
    expect(texts(root)).toEqual(expect.arrayContaining(['Q2', '900 USD', '500 USD']));
    expect(texts(root)).not.toContain('1,200 USD');
    expect(all(root, 'svg-path').filter((n) => n.props.fill).map((n) => n.props.fillOpacity)).toEqual([0.3, 0.3, 1, 1]);
    tap(plot(root), 250);
    expect(texts(root)).toContain('1,200 USD');
    expect(all(root, 'svg-path').filter((n) => n.props.fill).every((n) => n.props.fillOpacity === 1)).toBe(true);
  });

  test('a tap on a line reads the nearest point and draws a guide and a dot per series', () => {
    const root = render(`root = Stack([c])
c = LineChart(["Jan", "Feb", "Mar"], [s], "analytics")
s = Series("Visits", [1200, 1500, 1100])`);
    layOut(root, 302);
    tap(plot(root), 160);
    expect(texts(root)).toEqual(expect.arrayContaining(['Feb', '1,500']));
    // The line, the guide, and one dot.
    expect(all(root, 'svg-path').filter((n) => n.props.d?.startsWith('M150,0 V'))).toHaveLength(1);
    expect(all(root, 'svg-path').filter((n) => n.props.d?.includes(' a4,4 '))).toHaveLength(1);
  });

  test('a donut stacks its legend under the disc; a tap on a slice or its row reads it in the center and dims the rest', () => {
    const root = render(pie('donut'));
    const rows = all(root, 'pressable').filter((n) => String(n.props.accessibilityLabel ?? '').startsWith('Storage'));
    expect(rows).toHaveLength(1);
    press(rows[0]!);
    expect(texts(root)).toEqual(expect.arrayContaining(['25%', 'Storage']));
    expect(texts(root)).not.toContain('7,200');
    const arcs = all(root, 'svg-path');
    expect(arcs.map((n) => n.props.fillOpacity)).toEqual([0.3, 1, 0.3, 0.3]);
    press(arcs[1]!);
    expect(texts(root)).toContain('7,200');
  });
});
