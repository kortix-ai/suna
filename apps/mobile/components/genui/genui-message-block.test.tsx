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
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/separator', () => ({ Separator: host('separator') }));
mock.module('@/components/ui/progress', () => ({ Progress: host('progress') }));
mock.module('@/components/ui/tabs', () => ({
  Tabs: host('tabs'),
  TabsList: host('tabs-list'),
  TabsTrigger: host('tabs-trigger'),
  TabsContent: host('tabs-content'),
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
// The Map's list rows and its full-screen WebView sheet load native modules; genui-map.test.tsx covers them.
mock.module('@/components/kortix/settings-list', () => ({ SettingsGroup: host('settings-group'), SettingsRow: host('settings-row') }));
mock.module('./map/map-sheet', () => ({ MapSheet: host('map-sheet') }));
// The Map module loads native modules (clipboard, sheet); genui-map.test.tsx renders it.
mock.module('./components/map', () => ({ GenuiMap: host('genui-map') }));
// The chart's Show data sheet loads gorhom and Reanimated internals; components/charts.test.tsx covers it.
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: host('sheet') }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetScrollView: host('sheet-scroll') }));
mock.module('@/components/markdown/markdown-image', () => ({ MarkdownImage: host('markdown-image') }));
mock.module('@/lib/utils/open-link', () => ({ openExternalLink: (href: unknown) => opened.push(href), openLink: async () => {} }));
mock.module('@/lib/icons', () => ({
  TrendUpIcon: 'trend-up',
  TrendDownIcon: 'trend-down',
  MinusIcon: 'trend-flat',
  ArrowUpRightIcon: 'open',
  InfoIcon: 'info',
  WarningIcon: 'warning',
  CheckCircleIcon: 'check-circle',
  CircleIcon: 'circle',
  CaretDownIcon: 'caret-down',
  CaretRightIcon: 'caret-right',
  MapPinIcon: 'map-pin',
  MapTrifoldIcon: 'map-trifold',
  StarIcon: 'star',
}));

let GenuiMessageBlock: typeof import('./genui-message-block').GenuiMessageBlock;
let GenuiPending: typeof import('./components').GenuiPending;
let useGenuiStore: typeof import('@/stores/genui-store').useGenuiStore;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GenuiMessageBlock } = await import('./genui-message-block'));
  ({ GenuiPending } = await import('./components'));
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
/** Status chips: the pill View (a /15 tone tint), with its label. */
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
    const icons = all(root, 'icon');
    expect(icons.map((n) => n.props.as)).toEqual(['trend-up', 'trend-down', 'trend-flat']);
    // The glyph and the delta take the direction's color: up green, down red, flat muted.
    expect(icons.map(className)).toEqual(['text-kortix-green', 'text-kortix-red', 'text-muted-foreground']);
  });

  test('a delta with no trend takes its direction from its leading sign', () => {
    const root = render(`root = Stack([row])
row = StatRow([a, b])
a = Stat("Up", "1", "+12%")
b = Stat("Down", "2", "-3 pts")`);
    expect(all(root, 'icon').map((n) => n.props.as)).toEqual(['trend-up', 'trend-down']);
  });

  test('a StatRow is one card split by separators, two stats a row; a lone Stat is a larger card', () => {
    const root = render(`root = Stack([row, solo])
row = StatRow([a, b, c])
a = Stat("A", "1")
b = Stat("B", "2")
c = Stat("C", "3")
solo = Stat("Solo", "4")`);
    const card = all(root, 'view').find((n) => className(n).includes('overflow-hidden rounded-2xl bg-card'))!;
    // Rows [A|B] then [C]: one vertical separator, one horizontal separator between the rows.
    const seps = all(card, 'separator');
    expect(seps.map((n) => n.props.orientation ?? 'horizontal').sort()).toEqual(['horizontal', 'vertical']);
    // Cells share the card: no per-stat surface. The lone Stat is its own card, with the h4 number.
    const values = all(root, 'text').filter((n) => ['1', '2', '3', '4'].includes(texts(n).join('')));
    expect(values.map((n) => n.props.variant)).toEqual(['large', 'large', 'large', 'h4']);
    for (const value of values) expect(className(value)).toContain('font-medium');
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
    // Every cell reads at 14/20 like a markdown table, through the TYPE.sm token, never a text-sm class.
    for (const row of rows) {
      for (const cell of all(row, 'text')) {
        expect(flatten(cell.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        expect(String(cell.props.className)).not.toContain('text-sm');
      }
    }
  });

  test('compare cards mark the winner with a tinted card (no visible label; Pick in its accessibility name), and key repeated spec labels by position', () => {
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
      // No visible Pick label: the tint marks the pick, and the name carries it for screen readers.
      expect(all(root, 'text').filter((n) => texts(n).join('') === 'Pick')).toHaveLength(0);
      const named = all(root, 'text').filter((n) => n.props.accessibilityLabel);
      expect(named.map((n) => n.props.accessibilityLabel)).toEqual(['Y, Pick']);
      expect(all(root, 'badge')).toHaveLength(0);
      const cards = all(root, 'view').filter((n) => /\brounded-2xl\b/.test(className(n)) && /\bpx-4\b/.test(className(n)));
      expect(cards.map((n) => (className(n).includes('bg-secondary') ? 'tint' : 'card'))).toEqual(['card', 'tint']);
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

  test('a ranked list shows just the data, no rank numbers; #1 leads with the larger title', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);
    const root = render(
      [`root = Stack([list])`, `list = RankedList([${ids.join(', ')}])`, ...ids.map((id, i) => `${id} = RankedItem("Option ${i + 1}", "Reason")`)].join('\n'),
    );
    expect(all(root, 'text').filter((n) => /^\d+$/.test(texts(n).join('')))).toHaveLength(0);
    const titles = all(root, 'text').filter((n) => texts(n).join('').startsWith('Option '));
    expect(titles).toHaveLength(10);
    expect(className(titles[0]!)).toContain('text-lg');
    expect(className(titles[1]!)).not.toContain('text-lg');
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

  test('callouts take the solid glyph and the /15 tint of their tone; title and body stay ink', () => {
    const root = render(`root = Stack([a, b, c])
a = Callout("info", "A")
b = Callout("warn", "B")
c = Callout("success", "C")`);
    const icons = all(root, 'icon');
    expect(icons.map((n) => n.props.as)).toEqual(['info', 'warning', 'check-circle']);
    for (const icon of icons) expect(icon.props.weight).toBe('fill');
    expect(icons.map((n) => className(n).match(/text-kortix-\w+/)![0])).toEqual(['text-kortix-blue', 'text-kortix-orange', 'text-kortix-green']);
    const tints = all(root, 'view').map(className).filter((c) => /bg-kortix-\w+\/15/.test(c));
    expect(tints.map((c) => c.match(/bg-kortix-\w+\/15/)![0])).toEqual(['bg-kortix-blue/15', 'bg-kortix-orange/15', 'bg-kortix-green/15']);
  });

  test('badges follow Paper Badge 01: the tone paints the /15 tint and the label; neutral is the secondary well', () => {
    const root = render(`root = Stack([bad, good, warn, plain])
bad = Badge("Sold out", "bad")
good = Badge("Top pick", "good")
warn = Badge("Few left", "warn")
plain = Badge("Hotel")`);
    const found = all(root, 'view')
      .filter((n) => className(n).includes('rounded-md px-2'))
      .map((n) => ({ className: className(n), label: all(n, 'text')[0]! }));
    expect(found.map((chip) => texts(chip.label).join(''))).toEqual(['Sold out', 'Top pick', 'Few left', 'Hotel']);
    expect(found.map((chip) => chip.className.match(/bg-[\w-]+(\/15)?/)![0])).toEqual([
      'bg-kortix-red/15',
      'bg-kortix-green/15',
      'bg-kortix-orange/15',
      'bg-secondary',
    ]);
    expect(found.map((chip) => className(chip.label).match(/text-[\w-]+/)![0])).toEqual([
      'text-kortix-red',
      'text-kortix-green',
      'text-kortix-orange',
      'text-foreground',
    ]);
    expect(all(root, 'badge')).toHaveLength(0);
  });

  test('a table caption is the title above the table card', () => {
    const root = render(`root = Stack([t])
t = Table(["Region"], [["EU"]], "Seats by region")`);
    const shown = texts(root);
    expect(shown.indexOf('Seats by region')).toBeLessThan(shown.indexOf('Region'));
    const title = all(root, 'text').find((n) => texts(n).join('') === 'Seats by region')!;
    expect(className(title)).toContain('font-medium');
    expect(flatten(title.props.style)).toMatchObject({ fontSize: 14, lineHeight: 20 });
  });

  test('an image sits in the dark letterbox well with its caption chip and an open button', () => {
    const root = render(`root = Stack([pic])
pic = Image("https://example.com/venue.jpg", "Venue entrance", "The north door")`);
    expect(all(root, 'view').some((n) => className(n).includes('bg-terminal-surface'))).toBe(true);
    const open = all(root, 'button')[0]!;
    expect(open.props.accessibilityLabel).toBe('Open image');
    act(() => (open.props.onPress as () => void)());
    expect(opened).toEqual(['https://example.com/venue.jpg']);
    expect(texts(root)).toContain('The north door');
  });

  test('an image with text is a figure: a fixed-width picture beside the text, no letterbox well', () => {
    const root = render(`root = Image("https://example.com/photo.jpg", "A valid photo", null, "Plain light background, face forward.")`);
    expect(all(root, 'view').some((n) => className(n).includes('flex-row items-start'))).toBe(true);
    expect(all(root, 'view').some((n) => flatten(n.props.style)?.width === 112)).toBe(true);
    expect(all(root, 'view').some((n) => className(n).includes('bg-terminal-surface'))).toBe(false);
    expect(texts(root)).toContain('Plain light background, face forward.');
  });

  test('two or more images are a snap pager: one image per page at a fixed height, each with its caption, and a counter', () => {
    const img = (id: string) => `${id} = Image("https://example.com/${id}.png", "Photo ${id}", "Caption ${id}")`;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const root = render(`root = Stack([${ids.join(', ')}])\n${ids.map(img).join('\n')}`);
    const gallery = all(root, 'view').find((n) => n.props.accessibilityLabel === '7 images')!;
    // Pages need the measured width before they exist.
    act(() => (gallery.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 320 } } }));
    const [pager] = all(root, 'scroll');
    expect([pager!.props.horizontal, pager!.props.pagingEnabled, pager!.props.decelerationRate]).toEqual([true, true, 'fast']);
    expect(all(pager!, 'markdown-image')).toHaveLength(7);
    expect(all(pager!, 'markdown-image').every((n) => n.props.fixedHeight === 280)).toBe(true);
    expect(texts(root)).toEqual(expect.arrayContaining(['Caption a', 'Caption g', '1 / 7']));
    act(() => (pager!.props.onMomentumScrollEnd as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 640 } } }));
    expect(texts(root)).toContain('3 / 7');
  });

  test('a card with an image lays its badges over the image as pills with a tone dot; without one, under the body', () => {
    // A Callout between them keeps these two single Cards, not a card list.
    const root = render(`root = Stack([a, n, b])
a = Card("Option A", "Close", "184 EUR", "https://example.com/a.jpg", null, [g])
n = Callout("info", "Between")
b = Card("Option B", "Plain", null, null, null, [w])
g = Badge("Free cancellation", "good")
w = Badge("2 rooms left", "warn")`);
    const pill = (label: string) => all(root, 'view').find((n) => className(n).includes('rounded-full px-2') && texts(n).join('') === label)!;
    expect(className(pill('Free cancellation'))).toContain('bg-background');
    expect(className(pill('2 rooms left'))).toContain('bg-secondary');
    expect(all(pill('Free cancellation'), 'view').some((n) => className(n).includes('bg-kortix-green'))).toBe(true);
    expect(all(root, 'markdown-image')[0]!.props.fixedHeight).toBe(160);
  });

  test('two or more cards without a hint are a list: a 96pt thumbnail beside the title, rating, location, body, and tag pills', () => {
    const root = render(`root = Stack([a, b])
a = Card("Python", "General-purpose.", "Language", "https://example.com/python.png", "https://python.org", [t, g], 4.7, 1200, "Free")
b = Card("Go", "Backend.", "Language")
t = Badge("Popular")
g = Badge("Best for a first project", "good")`);
    const thumbs = all(root, 'view').filter((n) => n.props.style?.width === 96);
    expect(thumbs).toHaveLength(1);
    const image = () => all(thumbs[0]!, 'markdown-image')[0]!;
    // Before it loads, the thumbnail is a photo: it fills the square, cropped.
    expect([image().props.fixedHeight, image().props.look.resizeMode, image().props.look.bare]).toEqual([96, 'cover', true]);
    expect(className(thumbs[0]!)).not.toContain('p-1.5');
    // A narrow logo (under 240 px) sits whole inside a 6pt inset.
    act(() => (image().props.look.onSize as (w: number, h: number) => void)(200, 200));
    expect([image().props.fixedHeight, image().props.look.resizeMode]).toEqual([84, 'contain']);
    expect(className(thumbs[0]!)).toContain('p-1.5');
    expect(texts(root)).toEqual(expect.arrayContaining(['Python', '4.7', '(1,200)', 'Free', 'Language', 'General-purpose.', 'Popular', 'Go']));
    // List tags are tone-dot pills on the secondary well, not a muted "A · B" line.
    const pill = all(root, 'view').find((n) => className(n).includes('rounded-full px-2') && texts(n).join('') === 'Best for a first project')!;
    expect(className(pill)).toContain('bg-secondary');
    expect(all(pill, 'view').some((n) => className(n).includes('bg-kortix-green'))).toBe(true);
    expect(texts(root)).not.toContain('Popular · Best for a first project');
    expect(all(root, 'separator')).toHaveLength(1);
    const link = all(root, 'pressable').find((n) => n.props.accessibilityRole === 'link')!;
    act(() => (link.props.onPress as () => void)());
    expect(opened).toEqual(['https://python.org/']);
  });

  test('cards switch to the grid once most loaded images prove to be photos; logos keep the list', () => {
    const code = `root = Stack([a, b])
a = Card("Taj", null, null, "https://example.com/taj.jpg")
b = Card("Oberoi", null, null, "https://example.com/oberoi.jpg")`;
    const root = render(code);
    const size = (w: number, h: number) =>
      act(() => all(root, 'markdown-image').forEach((n) => (n.props.look.onSize as (w: number, h: number) => void)(w, h)));
    size(200, 200);
    expect(all(root, 'view').filter((n) => n.props.style?.width === 96)).toHaveLength(2);
    size(1920, 1080);
    expect(all(root, 'view').filter((n) => n.props.style?.width === 96)).toHaveLength(0);
    const grid = all(root, 'view').find((n) => typeof n.props.onLayout === 'function')!;
    act(() => (grid.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 340 } } }));
    // One column on a phone; each photo fills a tile at its own shape (1920x1080 is 16:9 → 340 x 191).
    const images = all(root, 'markdown-image');
    expect(images.map((n) => [n.props.fixedHeight, n.props.look.resizeMode])).toEqual([
      [191, 'cover'],
      [191, 'cover'],
    ]);
  });

  test('a layout hint wins: grid shows tiles before any image loads; a logo in the grid sits inset on a square', () => {
    const root = render(`root = Stack([a, b], "col", "grid")
a = Card("Python", null, null, "https://example.com/python.png")
b = Card("Go", null, null, "https://example.com/go.png")`);
    const grid = all(root, 'view').find((n) => typeof n.props.onLayout === 'function')!;
    act(() => (grid.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 340 } } }));
    expect(all(root, 'markdown-image').map((n) => n.props.fixedHeight)).toEqual([255, 255]);
    act(() => (all(root, 'markdown-image')[0]!.props.look.onSize as (w: number, h: number) => void)(200, 200));
    const tile = all(root, 'view').find((n) => n.props.style?.padding === 24)!;
    expect(tile.props.style.height).toBe(340);
    expect(all(tile, 'markdown-image')[0]!.props.fixedHeight).toBe(292);
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

  test('steps are rows on a rail: a 96pt cropped photo, the title with its meta, the text lines, a hairline to the next row', () => {
    const root = render(`root = Steps([s1, s2, s3])
s1 = Step("Home → Central Station", "Take a taxi or the bus.", "https://example.com/station.jpg", "about 20 min")
s2 = Step("Central Station → Airport One", "Take the airport train.\\nTrains leave every 15 minutes.", "https://example.com/train.jpg")
s3 = Step("Airport One", "Check in and board.")`);
    expect(all(root, 'fallback')).toHaveLength(0);
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Home → Central Station', 'about 20 min', 'Take a taxi or the bus.', 'Take the airport train.\nTrains leave every 15 minutes.', 'Airport One']),
    );
    const tiles = all(root, 'view').filter((n) => n.props.style?.width === 96 && n.props.style?.height === 96);
    const photos = tiles.filter((n) => all(n, 'markdown-image').length > 0);
    expect(photos).toHaveLength(2);
    // The row without a photo fills the same 96pt tile with its number, so every row has the same thumbnail.
    expect(tiles).toHaveLength(3);
    expect(texts(tiles[2]!)).toEqual(['3']);
    expect(all(photos[0]!, 'markdown-image')[0]!.props).toMatchObject({ src: 'https://example.com/station.jpg', alt: '', fixedHeight: 96, look: { bare: true, resizeMode: 'cover' } });
    // The row without a photo shows its number on the same 96pt rail.
    const rails = all(root, 'view').filter((n) => className(n) === 'items-center');
    expect(rails.map((n) => n.props.style.width)).toEqual([96, 96, 96]);
    expect(texts(rails[2]!)).toEqual(['3']);
    // A hairline joins each rail to the next row; the last row has none. min-h-4 keeps it visible on a row
    // whose text is shorter than its photo.
    expect(all(root, 'view').filter((n) => className(n).includes('min-h-4 w-px'))).toHaveLength(2);
    // A photo that fails to load gives its rail back to the step number, as on web.
    act(() => all(photos[0]!, 'markdown-image')[0]!.props.look.onError());
    const after = all(root, 'view').filter((n) => className(n) === 'items-center');
    expect(all(after[0]!, 'markdown-image')).toHaveLength(0);
    expect(texts(after[0]!)).toEqual(['1']);
    expect(all(after[1]!, 'markdown-image')).toHaveLength(1);
  });

  test('steps without photos keep a narrow rail with numbered dots', () => {
    const root = render(`root = Steps([a, b])
a = Step("Check in your bag")
b = Step("Find your gate", null, null, "about 30 min")`);
    const rails = all(root, 'view').filter((n) => className(n) === 'items-center');
    expect(rails.map((n) => [n.props.style.width, texts(n).join('')])).toEqual([
      [28, '1'],
      [28, '2'],
    ]);
    expect(all(root, 'markdown-image')).toHaveLength(0);
  });

  test('a checklist with no items yet shows 0/0 and an empty bar, never NaN', async () => {
    const { GenuiChecklist } = await import('./components/data');
    const props = { title: 'Bring', items: [] };
    act(() => {
      tree = create(<GenuiChecklist node={{ id: 'c', type: 'Checklist', props, partial: true }} props={props} renderChild={() => null} streaming />);
    });
    expect(texts(tree!.root)).toEqual(expect.arrayContaining(['Bring', '0/0 ready']));
    expect(all(tree!.root, 'progress').map((n) => n.props.value)).toEqual([0]);
  });

  test('when every step photo fails, the rail goes back to narrow numbered dots', () => {
    const root = render(`root = Steps([s1, s2, s3])
s1 = Step("One", "First.", "https://example.com/one.jpg")
s2 = Step("Two", "Second.")
s3 = Step("Three", "Third.")`);
    const rails = () => all(root, 'view').filter((n) => className(n) === 'items-center');
    expect(rails().map((n) => n.props.style.width)).toEqual([96, 96, 96]);
    act(() => all(root, 'markdown-image')[0]!.props.look.onError());
    expect(rails().map((n) => n.props.style.width)).toEqual([28, 28, 28]);
  });

  test('a checklist counts ticks: pressing an item ticks it, strikes it through, and moves the bar; pressing again unticks it', () => {
    const root = render(`root = Checklist("Your travel checklist", ["Valid passport", "Visa", "Hotel address"])`);
    expect(all(root, 'fallback')).toHaveLength(0);
    expect(texts(root)).toEqual(expect.arrayContaining(['Your travel checklist', '0/3 ready', 'Valid passport', 'Visa', 'Hotel address']));
    expect(all(root, 'progress')[0]!.props.value).toBe(0);
    const boxes = () => all(root, 'pressable').filter((n) => n.props.accessibilityRole === 'checkbox');
    expect(boxes().map((n) => n.props.accessibilityState.checked)).toEqual([false, false, false]);
    // A 44pt row is a reliable tap target.
    expect(className(boxes()[0]!)).toContain('min-h-11');
    // An open item sends no weight, so the app weight (bold) applies; undefined would reset it to regular.
    expect('weight' in all(boxes()[0]!, 'icon')[0]!.props).toBe(false);
    press(boxes()[1]!);
    expect(texts(root)).toContain('1/3 ready');
    expect(all(root, 'progress')[0]!.props.value).toBeCloseTo(100 / 3);
    expect(boxes().map((n) => n.props.accessibilityState.checked)).toEqual([false, true, false]);
    expect(all(boxes()[1]!, 'icon')[0]!.props).toMatchObject({ as: 'check-circle', weight: 'fill' });
    expect(className(all(boxes()[1]!, 'text')[0]!)).toContain('line-through');
    press(boxes()[1]!);
    expect(texts(root)).toContain('0/3 ready');
    expect(all(boxes()[1]!, 'icon')[0]!.props.as).toBe('circle');
  });

  test('streaming steps and a checklist render every prefix without a crash; a half-written step waits for its photo', () => {
    const code = `root = Stack([steps, list])
steps = Steps([s1, s2])
s1 = Step("Home → Station", "Take a taxi.", "https://example.com/a.jpg", "20 min")
s2 = Step("Station → Airport", "Train.")
list = Checklist("Bring", ["Passport", "Visa"])`;
    for (let cut = 1; cut < code.length; cut += 7) {
      act(() => {
        tree?.update(<GenuiMessageBlock code={code.slice(0, cut)} version={1} isStreaming renderMarkdown={fallback} />);
        if (!tree) tree = create(<GenuiMessageBlock code={code.slice(0, cut)} version={1} isStreaming renderMarkdown={fallback} />);
      });
      expect(texts(tree!.root)).not.toContain('undefined');
    }
    // s1 has its whole URL but is not closed yet: its rail shows the number, not a half-loaded photo.
    const open = code.indexOf('"20 min")') + '"20 min"'.length;
    act(() => tree!.update(<GenuiMessageBlock code={code.slice(0, open)} version={1} isStreaming renderMarkdown={fallback} />));
    expect(all(tree!.root, 'markdown-image')).toHaveLength(0);
    act(() => tree!.update(<GenuiMessageBlock code={code} version={1} isStreaming={false} renderMarkdown={fallback} />));
    expect(all(tree!.root, 'markdown-image')).toHaveLength(1);
    expect(texts(tree!.root)).toEqual(expect.arrayContaining(['Station → Airport', '0/2 ready', 'Passport', 'Visa']));
  });

  test('every shared debug sample without issues renders as UI, so the mobile debug screen shows each block', async () => {
    const { GENUI_SAMPLES } = await import('@kortix/shared/genui-samples');
    const { parseGenui } = await import('@kortix/sdk/genui');
    const clean = GENUI_SAMPLES.filter((sample) => parseGenui(sample.source).issues.length === 0);
    expect(clean.map((sample) => sample.component)).toEqual(expect.arrayContaining(['Steps', 'Checklist']));
    for (const sample of clean) {
      const root = render(sample.source);
      expect([sample.title ?? sample.component, all(root, 'fallback').length]).toEqual([sample.title ?? sample.component, 0]);
      act(() => tree?.unmount());
      tree = undefined;
    }
  });

  // Chart behavior (header row, legend, Show data sheet, pie layouts) lives in components/charts.test.tsx.
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
