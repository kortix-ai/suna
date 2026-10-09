/**
 * A generative-UI Map renders from real OpenUI source through the real SDK parser, as place rows.
 * The interactive map is a full-screen sheet that exists only when a tile style is configured.
 * React Native and the design-system primitives are host stubs (the genui-message-block.test.tsx
 * harness), so the assertions read what the component hands to them. Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import type { GenuiNode } from '@kortix/sdk/genui';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

const opened: unknown[] = [];

mock.module('react-native', () => ({
  StyleSheet: { flatten: (s: unknown) => s, create: (s: unknown) => s },
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
  useReducedMotion: () => false,
  useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
  useAnimatedStyle: (style: () => unknown) => style(),
  withTiming: (to: unknown) => to,
}));
mock.module('react-native-gesture-handler', () => ({ ScrollView: host('gh-scroll') }));
mock.module('react-native-svg', () => ({ default: host('svg'), G: host('svg-g'), Path: host('svg-path') }));
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
mock.module('@/components/kortix/settings-list', () => ({
  SettingsGroup: host('settings-group'),
  SettingsRow: host('settings-row'),
}));
mock.module('@/components/markdown/markdown-image', () => ({ MarkdownImage: host('markdown-image') }));
mock.module('@/components/markdown/markdown-text', () => ({ openExternalLink: (href: unknown) => opened.push(href) }));
mock.module('./map/map-sheet', () => ({ MapSheet: host('map-sheet') }));
mock.module('@/lib/icons', () => ({
  ArrowUpRightIcon: 'trend-up',
  ArrowDownRightIcon: 'trend-down',
  MinusIcon: 'trend-flat',
  InfoIcon: 'info',
  WarningIcon: 'warning',
  CheckCircleIcon: 'check-circle',
  CaretDownIcon: 'caret-down',
  CaretRightIcon: 'caret-right',
  MapPinIcon: 'map-pin',
  MapTrifoldIcon: 'map-trifold',
}));

const STYLE_URL = 'https://tiles.example.com/style.json';
let GenuiMessageBlock: typeof import('./genui-message-block').GenuiMessageBlock;
let GenuiMap: typeof import('./components/map').GenuiMap;
let parseGenui: typeof import('@kortix/sdk/genui').parseGenui;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ GenuiMessageBlock } = await import('./genui-message-block'));
  ({ GenuiMap } = await import('./components/map'));
  ({ parseGenui } = await import('@kortix/sdk/genui'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  opened.length = 0;
});

function render(code: string) {
  act(() => {
    tree = create(
      <GenuiMessageBlock code={code} version={1} isStreaming={false} renderMarkdown={(md) => React.createElement('fallback', null, md)} />,
    );
  });
  return tree!.root;
}

/** The Map node of real source, rendered alone with an explicit tile style (`''` is the unset .env.example value). */
function renderMap(code: string, styleUrl: string) {
  const map = (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
  act(() => {
    tree = create(<GenuiMap node={map} props={map.props} renderChild={() => null} streaming={false} styleUrl={styleUrl} />);
  });
  return tree!.root;
}

const all = (root: ReactTestInstance, type: string) => root.findAll((n) => n.type === (type as never));
const rows = (root: ReactTestInstance) => all(root, 'settings-row');
const press = (n: ReactTestInstance) => act(() => (n.props.onPress as () => void)());
const texts = (root: ReactTestInstance) => all(root, 'text').flatMap((n) => n.children.filter((c) => typeof c === 'string'));

const TWO_PLACES = `root = Stack([m])
m = Map([a, b], "places tool", 12, [[48.85, 2.35], [48.86, 2.36]])
a = Marker(48.85, 2.35, "Louvre", "Museum")
b = Marker(48.86, 2.36, "Opera")`;

describe('mobile genui Map', () => {
  test('each place is a list row that opens OpenStreetMap outside the app; the source line follows', () => {
    const root = render(TWO_PLACES);
    expect(all(root, 'fallback')).toHaveLength(0);
    expect(rows(root).map((r) => [r.props.label, r.props.icon, r.props.external, r.props.dense])).toEqual([
      ['Louvre', 'map-pin', true, true],
      ['Opera', 'map-pin', true, true],
    ]);
    // Descriptions belong to the full-screen popups, never under a row.
    expect(rows(root).every((r) => r.props.description === undefined)).toBe(true);
    press(rows(root)[1]!);
    expect(opened).toEqual(['https://www.openstreetmap.org/?mlat=48.86&mlon=2.36#map=15/48.86/2.36']);
    expect(texts(root)).toContain('Source: places tool');
  });

  test('with no tile style configured there is no Open map row and no map sheet, and no WebView anywhere', () => {
    const root = renderMap(TWO_PLACES, '');
    expect(rows(root).map((r) => r.props.label)).toEqual(['Louvre', 'Opera']);
    expect(all(root, 'map-sheet')).toHaveLength(0);
  });

  test('with a tile style, Open map leads the rows; the sheet mounts only when pressed, with every place, route, and zoom', () => {
    const root = renderMap(TWO_PLACES, STYLE_URL);
    const [openMap] = rows(root);
    expect([openMap!.props.label, openMap!.props.icon, openMap!.props.external]).toEqual(['Open map', 'map-trifold', undefined]);
    expect(all(root, 'map-sheet')).toHaveLength(0);
    press(openMap!);
    const [sheet] = all(root, 'map-sheet');
    expect(sheet!.props.title).toBe('Map');
    expect(sheet!.props.data).toEqual({
      styleUrl: STYLE_URL,
      markers: [
        { id: 'a', lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' },
        { id: 'b', lat: 48.86, lng: 2.36, label: 'Opera', description: undefined },
      ],
      route: [
        [48.85, 2.35],
        [48.86, 2.36],
      ],
      zoom: 12,
    });
    act(() => (sheet!.props.onClose as () => void)());
    expect(all(root, 'map-sheet')).toHaveLength(0);
  });

  test('a map of one place titles its sheet with that place', () => {
    const root = renderMap(
      `root = Stack([m])
m = Map([a], "places tool")
a = Marker(48.85, 2.35, "Louvre")`,
      STYLE_URL,
    );
    press(rows(root)[0]!);
    expect(all(root, 'map-sheet')[0]!.props.title).toBe('Louvre');
  });
});
