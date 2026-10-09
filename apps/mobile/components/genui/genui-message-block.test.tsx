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

mock.module('react-native', () => ({
  StyleSheet: { flatten, create: (s: unknown) => s },
  View: host('view'),
  Text: host('rntext'),
  Pressable: host('pressable'),
  ScrollView: host('scroll'),
  Image: host('image'),
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
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
    expect(all(root, 'badge')).toHaveLength(0);
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

  test('callouts take the glyph of their tone', () => {
    const root = render(`root = Stack([a, b, c])
a = Callout("info", "A")
b = Callout("warn", "B")
c = Callout("success", "C")`);
    expect(all(root, 'icon').map((n) => n.props.as)).toEqual(['info', 'warning', 'check-circle']);
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
