/**
 * A generative-UI block renders the mobile components from real OpenUI source,
 * through the real SDK parser. React Native and the design-system primitives are
 * host stubs, so the assertions read what each component hands to them.
 * Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style ?? {}) as Record<string, unknown>);

const opened: unknown[] = [];
const motion = { reduced: false, timings: [] as unknown[] };

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s },
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  ScrollView: host('scroll'),
  Image: host('image'),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
}));
mock.module('react-native-reanimated', () => ({
  default: { View: host('animated-view') },
  Easing: { bezier: () => 'ease-out' },
  useReducedMotion: () => motion.reduced,
  useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
  useAnimatedStyle: (style: () => unknown) => style(),
  withTiming: (to: unknown, config: unknown) => (motion.timings.push(config), to),
}));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('react-native-svg', () => ({ default: host('svg'), G: host('svg-g'), Path: host('svg-path') }));
// `lib/utils/theme` builds NAV_THEME from React Navigation's themes, which do not load under Bun.
mock.module('expo-router/react-navigation', () => ({ DefaultTheme: {}, DarkTheme: {} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
/** i18next's two call shapes: `t(key, fallback)` and `t(key, { defaultValue, ...values })`. */
const translate = (_key: string, options: string | Record<string, unknown>) =>
  typeof options === 'string'
    ? options
    : String(options.defaultValue).replace(/{{(\w+)}}/g, (_m, name: string) => String(options[name]));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/badge', () => ({ Badge: host('badge') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/separator', () => ({ Separator: host('separator') }));
mock.module('@/components/ui/tabs', () => ({
  Tabs: host('tabs'),
  TabsList: host('tabs-list'),
  TabsTrigger: host('tabs-trigger'),
  TabsContent: host('tabs-content'),
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/components/markdown/markdown-image', () => ({ MarkdownImage: host('markdown-image') }));
mock.module('@/components/markdown/markdown-text', () => ({ openExternalLink: (href: unknown) => opened.push(href) }));
mock.module('@/lib/icons', () => ({
  ArrowUpRightIcon: 'trend-up',
  ArrowDownRightIcon: 'trend-down',
  MinusIcon: 'trend-flat',
  InfoIcon: 'info',
  WarningIcon: 'warning',
  CheckCircleIcon: 'check-circle',
  CaretDownIcon: 'caret-down',
  CaretRightIcon: 'caret-right',
}));

let GenuiMessageBlock: typeof import('./genui-message-block').GenuiMessageBlock;
let GenuiPending: typeof import('./components').GenuiPending;
let GenuiChart: typeof import('./components/charts').GenuiChart;
let useGenuiStore: typeof import('@/stores/genui-store').useGenuiStore;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GenuiMessageBlock } = await import('./genui-message-block'));
  ({ GenuiPending } = await import('./components'));
  ({ GenuiChart } = await import('./components/charts'));
  ({ useGenuiStore } = await import('@/stores/genui-store'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  opened.length = 0;
  motion.reduced = false;
  motion.timings.length = 0;
  act(() => {
    useGenuiStore.getState().setEnabled(true);
  });
});

const fallback = (markdown: string) => React.createElement('fallback', null, markdown);

function render(code: string, isStreaming = false) {
  act(() => {
    tree = create(<GenuiMessageBlock code={code} version={1} isStreaming={isStreaming} renderMarkdown={fallback} />);
  });
  return tree!.root;
}

/** Every string a host text element holds, flattened, in render order. */
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
const className = (n: ReactTestInstance) => String(n.props.className ?? '');
/** Status chips: the pill View of `StatusChip`, with its label. */
const chips = (root: ReactTestInstance) =>
  all(root, 'view')
    .filter((n) => className(n).includes('rounded-full'))
    .map((n) => ({ className: className(n), label: all(n, 'text')[0]! }));

const EVERYTHING = `root = Stack([stats, card, table, cmp, list, tabs, note, pic, link])
stats = StatRow([s1, s2])
s1 = Stat("Revenue", "12k", "+4%", "up", "USD")
s2 = Stat("Users", "900")
card = Card("Option A", "Close to the venue", "4.7 stars", null, null, [tag])
tag = Badge("Top pick", "good")
table = Table(["Name", "Value"], [["a", 1]], "Sample")
cmp = Compare([x, y], ["Price"], "X")
x = CompareItem("X", ["$10"], ["Cheap"])
y = CompareItem("Y", ["$20"], [], ["Pricey"])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall", "4.9")
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")
note = Callout("warn", "Check the dates", "Note")
pic = Image("https://example.com/venue.jpg", "Venue entrance", "The north door")
link = Link("Book", "https://example.com/book")`;

const ACCORDION = `root = Stack([acc])
acc = Accordion([a1, a2])
a1 = AccordionItem("Details", [b1])
a2 = AccordionItem("Policies", [b2])
b1 = Badge("first")
b2 = Badge("second")`;
const BARS = `root = Stack([c])
c = BarChart(["Q1", "Q2"], [rev, cost], "billing export", "USD")
rev = Series("Revenue", [1200, 900])
cost = Series("Cost", [400, 500])`;
/** The plot measures itself before it draws: report a width the way React Native's layout pass would. */
const layOut = (root: ReactTestInstance, width: number) =>
  act(() => all(root, 'view').find((n) => n.props.onLayout)!.props.onLayout({ nativeEvent: { layout: { width } } }));

const triggers = (root: ReactTestInstance) =>
  all(root, 'pressable').filter((n) => n.props.accessibilityRole === 'button');
const press = (n: ReactTestInstance) => act(() => (n.props.onPress as () => void)());
const caretTurn = (root: ReactTestInstance, index: number) =>
  (flatten(all(root, 'animated-view')[index]!.props.style).transform as { rotate: string }[])[0]!.rotate;

describe('mobile genui components', () => {
  test('every layout, data, and inline component renders from real source without falling back', () => {
    const root = render(EVERYTHING);
    const shown = texts(root).join('|');
    for (const text of ['Revenue', '12k', 'USD', '+4%', 'Users', 'Option A', '4.7 stars', 'Close to the venue', 'Top pick', 'Name', 'Sample', '$10', 'Cheap', 'Pricey', 'First', 'Best overall', '4.9', 'One', 'Two', 'first', 'second', 'Note', 'Check the dates', 'The north door', 'Book']) {
      expect(shown).toContain(text);
    }
    expect(all(root, 'fallback')).toHaveLength(0);
  });

  test('turned off, the block renders its markdown fallback and no component', () => {
    act(() => {
      useGenuiStore.getState().setEnabled(false);
    });
    const root = render(EVERYTHING);
    expect(all(root, 'fallback')).toHaveLength(1);
    expect(chips(root)).toHaveLength(0);
  });

  test('the stat shows its trend glyph beside the delta', () => {
    const root = render(`root = Stack([row])
row = StatRow([a, b, c])
a = Stat("Up", "1", "+1", "up")
b = Stat("Down", "2", "-1", "down")
c = Stat("Flat", "3", "0", "flat")`);
    expect(all(root, 'icon').map((n) => n.props.as)).toEqual(['trend-up', 'trend-down', 'trend-flat']);
  });

  test('table columns line up: every row gives a column the same basis, and numbers align right', () => {
    const root = render(`root = Stack([t])
t = Table(["Name", "Nights", "Note"], [["Option A", 3, "Close to the venue and the station"], ["B", 12, "x"]])`);
    const rows = all(root, 'view').filter((n) => String(n.props.className ?? '').includes('flex-row') && all(n, 'text').length === 3);
    expect(rows).toHaveLength(3);
    for (const col of [0, 1, 2]) {
      const bases = rows.map((row) => flatten(all(row, 'text')[col]!.props.style).flexBasis);
      expect(typeof bases[0]).toBe('number');
      expect(new Set(bases).size).toBe(1);
    }
    const nights = rows.map((row) => String(all(row, 'text')[1]!.props.className));
    for (const className of nights) expect(className).toContain('text-right');
    expect(String(all(rows[1]!, 'text')[0]!.props.className)).not.toContain('text-right');
  });

  test('compare cards mark the winner with the translated Pick badge and key repeated spec labels by position', () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const root = render(`root = Stack([cmp])
cmp = Compare([x, y], ["Price", "Price"], "Y")
x = CompareItem("X", ["$10", "$11"], ["Cheap", "Cheap"])
y = CompareItem("Y", ["$20", "$21"])`);
      const shown = texts(root);
      for (const value of ['$10', '$11', '$20', '$21']) expect(shown).toContain(value);
      expect(all(root, 'badge').map((badge) => texts(badge).join(''))).toEqual(['Pick']);
    } finally {
      console.error = original;
    }
    expect(errors.filter((error) => error.includes('same key'))).toEqual([]);
  });

  test('a ranked item with a link opens it from the whole row', () => {
    const root = render(`root = Stack([list])
list = RankedList([a, b])
a = RankedItem("Option A", "Closest", null, null, "https://example.com/a")
b = RankedItem("Option B", "Quietest")`);
    const links = all(root, 'pressable').filter((n) => n.props.accessibilityRole === 'link');
    expect(links).toHaveLength(1);
    act(() => (links[0]!.props.onPress as () => void)());
    expect(opened).toEqual(['https://example.com/a']);
  });

  test('links and linked cards open through the markdown link opener', () => {
    const root = render(`root = Stack([card, link])
card = Card("Option A", null, null, null, "https://example.com/card")
link = Link("Book", "https://example.com/book")`);
    const links = all(root, 'pressable').filter((n) => n.props.accessibilityRole === 'link');
    expect(links).toHaveLength(2);
    for (const link of links) act(() => (link.props.onPress as () => void)());
    expect(opened).toEqual(['https://example.com/card', 'https://example.com/book']);
  });

  test('images render through the markdown image policy with their alt text', () => {
    const root = render(`root = Stack([pic, card])
pic = Image("https://example.com/venue.jpg", "Venue entrance", "The north door")
card = Card("Option A", null, null, "https://example.com/card.jpg")`);
    expect(all(root, 'markdown-image').map((n) => [n.props.src, n.props.alt])).toEqual([
      ['https://example.com/venue.jpg', 'Venue entrance'],
      ['https://example.com/card.jpg', ''],
    ]);
    expect(all(root, 'image')).toHaveLength(0);
  });

  test('callouts take the glyph and the /15 tint of their tone, with ink icon and text', () => {
    const root = render(`root = Stack([a, b, c])
a = Callout("info", "A")
b = Callout("warn", "B")
c = Callout("success", "C")`);
    const icons = all(root, 'icon');
    expect(icons.map((n) => n.props.as)).toEqual(['info', 'warning', 'check-circle']);
    for (const icon of icons) expect(className(icon)).toContain('text-foreground');
    const tints = all(root, 'view').map(className).filter((c) => /bg-kortix-\w+\/15/.test(c));
    expect(tints.map((c) => c.match(/bg-kortix-\w+\/15/)![0])).toEqual(['bg-kortix-blue/15', 'bg-kortix-orange/15', 'bg-kortix-green/15']);
  });

  test('badges are informational status chips: the tone is a /15 tint, the label stays ink', () => {
    const root = render(`root = Stack([bad, good, warn, plain])
bad = Badge("Sold out", "bad")
good = Badge("Top pick", "good")
warn = Badge("Few left", "warn")
plain = Badge("Hotel")`);
    const found = chips(root);
    expect(found.map((chip) => texts(chip.label).join(''))).toEqual(['Sold out', 'Top pick', 'Few left', 'Hotel']);
    expect(found[0]!.className).toContain('bg-kortix-red/15');
    expect(found[1]!.className).toContain('bg-kortix-green/15');
    expect(found[2]!.className).toContain('bg-kortix-orange/15');
    expect(found[3]!.className).toContain('bg-secondary');
    expect(found[3]!.className).not.toContain('kortix-');
    for (const chip of found) {
      expect(className(chip.label)).toContain('text-foreground');
      expect(className(chip.label)).not.toContain('destructive');
    }
    expect(all(root, 'badge')).toHaveLength(0);
  });

  test('tables and tab labels scroll sideways on the gesture-handler ScrollView, as markdown tables do', () => {
    const root = render(`root = Stack([t, tabs])
t = Table(["Name"], [["a"]])
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")`);
    expect(all(root, 'gh-scroll')).toHaveLength(2);
    expect(all(root, 'scroll')).toHaveLength(0);
  });

  test('while streaming, tabs show the tab being written; settled, the first', () => {
    const code = `root = Stack([tabs])
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")`;
    const live = render(code, true);
    const ids = all(live, 'tabs-trigger').map((n) => n.props.value);
    expect(all(live, 'tabs')[0]!.props.value).toBe(ids[1]);
    const settled = render(code, false);
    expect(all(settled, 'tabs')[0]!.props.value).toBe(ids[0]);
  });

  test('tabs streamed top-down settle on the first tab and show its content', () => {
    const lines = [
      'root = Stack([tabs])',
      'tabs = Tabs([t1, t2])',
      't1 = Tab("One", [b1])',
      'b1 = Badge("first")',
      't2 = Tab("Two", [b2])',
      'b2 = Badge("second")',
    ];
    const block = (code: string, isStreaming: boolean) => (
      <GenuiMessageBlock code={code} version={1} isStreaming={isStreaming} renderMarkdown={fallback} />
    );
    act(() => {
      tree = create(block(lines.slice(0, 2).join('\n'), true));
    });
    for (const count of [4, 6]) {
      act(() => tree!.update(block(lines.slice(0, count).join('\n'), true)));
    }
    act(() => tree!.update(block(lines.join('\n'), false)));
    const root = tree!.root;
    const ids = all(root, 'tabs-trigger').map((n) => n.props.value);
    expect(ids).toHaveLength(2);
    const active = all(root, 'tabs')[0]!.props.value;
    expect(active).toBe(ids[0]);
    const content = all(root, 'tabs-content').find((n) => n.props.value === active)!;
    expect(texts(content)).toContain('first');
  });

  test('a Tabs that mounted before its tabs existed settles on the first tab without a remount', async () => {
    // GenuiBlock remounts node views when the stream settles; this holds even if it stops doing so.
    const { GenuiTabs } = await import('./components/layout');
    const tab = (id: string, label: string, badge: string) => ({
      id,
      type: 'Tab',
      partial: false,
      props: { label, children: [{ id: `${id}-b`, type: 'Badge', partial: false, props: { label: badge } }] },
    });
    const renderChild = (node: { id: string; props: Record<string, unknown> }) => (
      <text key={node.id}>{String(node.props.label)}</text>
    );
    const view = (tabs: unknown[], streaming: boolean) => (
      <GenuiTabs node={{ id: 'tabs', type: 'Tabs', partial: false, props: { tabs } }} props={{ tabs }} renderChild={renderChild as never} streaming={streaming} />
    );
    act(() => {
      tree = create(view([], true));
    });
    act(() => tree!.update(view([tab('t1', 'One', 'first')], true)));
    act(() => tree!.update(view([tab('t1', 'One', 'first'), tab('t2', 'Two', 'second')], false)));
    expect(all(tree!.root, 'tabs')[0]!.props.value).toBe('t1');
  });

  test('an accordion shows every item title collapsed, with its content hidden until pressed', () => {
    const root = render(ACCORDION);
    expect(all(root, 'fallback')).toHaveLength(0);
    const rows = triggers(root);
    expect(rows.map((row) => texts(row).join(''))).toEqual(['Details', 'Policies']);
    expect(rows.map((row) => row.props.accessibilityState)).toEqual([{ expanded: false }, { expanded: false }]);
    expect(texts(root)).not.toContain('first');
    expect(texts(root)).not.toContain('second');
    expect(all(root, 'separator')).toHaveLength(1);
  });

  test('pressing an accordion item toggles its content and expanded state; items open independently', () => {
    const root = render(ACCORDION);
    press(triggers(root)[0]!);
    expect(triggers(root).map((row) => row.props.accessibilityState)).toEqual([{ expanded: true }, { expanded: false }]);
    expect(texts(root)).toContain('first');
    expect(texts(root)).not.toContain('second');
    press(triggers(root)[1]!);
    expect(texts(root)).toContain('second');
    press(triggers(root)[0]!);
    expect(triggers(root)[0]!.props.accessibilityState).toEqual({ expanded: false });
    expect(texts(root)).not.toContain('first');
  });

  test('the accordion caret turns 180° in a 200 ms ease-out; under Reduce Motion it snaps', () => {
    const root = render(ACCORDION);
    expect(caretTurn(root, 0)).toBe('0deg');
    expect(all(root, 'icon').map((n) => n.props.as)).toEqual(['caret-down', 'caret-down']);
    press(triggers(root)[0]!);
    expect(caretTurn(root, 0)).toBe('180deg');
    expect(motion.timings).toEqual([{ duration: 200, easing: 'ease-out' }]);
    act(() => tree!.unmount());
    motion.reduced = true;
    motion.timings.length = 0;
    const still = render(ACCORDION);
    press(triggers(still)[0]!);
    expect(caretTurn(still, 0)).toBe('180deg');
    expect(motion.timings).toEqual([]);
  });

  test('a chart is a figure carrying the SDK screen-reader text, with a legend for 2+ series and its source line', () => {
    const root = render(BARS);
    expect(all(root, 'fallback')).toHaveLength(0);
    const figure = all(root, 'view').filter((n) => n.props.accessibilityRole === 'image');
    expect(figure.map((n) => n.props.accessibilityLabel)).toEqual(['Bar chart: Revenue, Cost. Source: billing export']);
    // The figure alone is one accessibility element: the Show data button stays reachable.
    expect(all(root, 'view').filter((n) => n.props.accessible)).toHaveLength(1);
    const shown = texts(root);
    for (const text of ['Revenue', 'Cost', 'Q1', 'Q2']) expect(shown).toContain(text);
    // The unit rides on the source line, so a single-series chart (no legend) still states it.
    expect(shown).toContain('Source: billing export · USD');
  });

  test('after layout, bars draw on the brand chart ramp in web order, with the max value labelled', () => {
    const root = render(BARS);
    layOut(root, 300);
    const fills = all(root, 'svg-path').map((n) => n.props.fill).filter(Boolean);
    // Series 1 is --chart-3, series 2 --chart-5: in the comma form native renderers parse.
    expect(fills).toEqual(['hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)', 'hsla(30.1, 100%, 44.1%, 1)', 'hsla(23.8, 100%, 29.6%, 1)']);
    expect(texts(root)).toContain('1,200 USD');
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
    expect(texts(root)).not.toContain('1 USD');
    expect(texts(root).some((text) => text.endsWith(' USD') && !text.startsWith('Source'))).toBe(false);
  });

  test('Show data keeps values past the last label, in rows numbered by position', () => {
    const root = render(`root = Stack([c])
c = BarChart(["Q1"], [s], "billing export")
s = Series("Revenue", [10, 20, 30])`);
    press(triggers(root)[0]!);
    const shown = texts(root);
    for (const text of ['Q1', '10', '2', '20', '3', '30']) expect(shown).toContain(text);
  });

  test('a pie share treats a negative value as 0, as the slices do', () => {
    const node = {
      id: 'p',
      type: 'PieChart',
      props: { source: 'survey', slices: [
        { id: 'a', type: 'Slice', props: { label: 'Yes', value: 3 } },
        { id: 'b', type: 'Slice', props: { label: 'No', value: -1 } },
      ] },
    };
    act(() => {
      tree = create(<GenuiChart node={node as never} props={node.props} renderChild={() => null} streaming={false} />);
    });
    const shown = texts(tree!.root);
    expect(shown).toContain('Yes 100%');
    expect(shown).toContain('No 0%');
  });

  test('a single-series chart has no legend: the title names it', () => {
    const root = render(`root = Stack([c])
c = LineChart(["Mon", "Tue", "Wed"], [s], "app logs")
s = Series("Visits", [3, 5, 4])`);
    layOut(root, 300);
    expect(texts(root)).not.toContain('Visits');
    // A line labels the ends of its x axis, where its first and last points sit.
    expect(texts(root)).toEqual(expect.arrayContaining(['Mon', 'Wed']));
    expect(texts(root)).not.toContain('Tue');
    expect(all(root, 'svg-path').filter((n) => n.props.fill === 'none')).toHaveLength(1);
  });

  test('a pie chart draws one slice per non-zero value and names each slice with its share', () => {
    const root = render(`root = Stack([c])
c = PieChart([a, b, z], "survey")
a = Slice("Yes", 3)
b = Slice("No", 1)
z = Slice("Unsure", 0)`);
    layOut(root, 300);
    expect(all(root, 'svg-path')).toHaveLength(2);
    const shown = texts(root).join('|');
    for (const text of ['Yes', '75%', 'No', '25%', 'Unsure', '0%']) expect(shown).toContain(text);
  });

  test('Show data toggles a table of every value, and the button reports its state', () => {
    const root = render(BARS);
    const button = () => triggers(root)[0]!;
    expect(texts(button())).toContain('Show data');
    expect(button().props.accessibilityState).toEqual({ expanded: false });
    expect(texts(root)).not.toContain('1,200');
    press(button());
    expect(texts(button())).toContain('Hide data');
    expect(button().props.accessibilityState).toEqual({ expanded: true });
    for (const value of ['1,200', '900', '400', '500']) expect(texts(root)).toContain(value);
    press(button());
    expect(texts(root)).not.toContain('1,200');
  });

  test('pending heavy nodes hold their final height with the Kortix loader; pending text nodes render nothing', () => {
    act(() => {
      tree = create(<>{GenuiPending({ id: 't', type: 'Table', props: {}, partial: true })}</>);
    });
    const box = all(tree!.root, 'view')[0]!;
    expect(flatten(box.props.style).height).toBe(160);
    expect(all(tree!.root, 'loader')).toHaveLength(1);
    expect(GenuiPending({ id: 's', type: 'Stat', props: {}, partial: true })).toBeNull();
  });
});
