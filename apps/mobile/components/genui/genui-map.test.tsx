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
// `openGenuiLink` opens through the app's link helper — stub it so the real
// `expo-web-browser` (and its native modules) never loads in this host-stub run.
// `openLink` is the tel: path (Call), which `openExternalLink` refuses.
mock.module('@/lib/utils/open-link', () => ({
  openExternalLink: (href: string) => opened.push(href),
  openLink: async (href: string) => {
    opened.push(href);
  },
}));

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
mock.module('@/components/ui/progress', () => ({ Progress: host('progress') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
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
mock.module('./map/map-sheet', () => ({ MapSheet: host('map-sheet'), MapWebView: host('map-webview') }));
// The chart card's Show data sheet is reachable through the shared genui imports; gorhom does not load under Bun.
mock.module('@/components/kortix/sheet', () => ({ KortixBottomSheetModal: host('sheet') }));
mock.module('@gorhom/bottom-sheet', () => ({ BottomSheetScrollView: host('sheet-scroll') }));
mock.module('@/lib/icons', () => ({
  ArrowUpRightIcon: 'trend-up',
  ArrowDownRightIcon: 'trend-down',
  MinusIcon: 'trend-flat',
  InfoIcon: 'info',
  WarningIcon: 'warning',
  CheckCircleIcon: 'check-circle',
  CircleIcon: 'circle',
  CaretDownIcon: 'caret-down',
  CaretRightIcon: 'caret-right',
  MapPinIcon: 'map-pin',
  MapTrifoldIcon: 'map-trifold',
  TrendDownIcon: 'trend-down',
  TrendUpIcon: 'trend-up',
  StarIcon: 'star',
}));
let mockDark = false;
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: mockDark ? 'dark' : 'light' }) }));

const STYLE_URL = 'https://tiles.example.com/style.json';
let GenuiMessageBlock: typeof import('./genui-message-block').GenuiMessageBlock;
let GenuiMap: typeof import('./components/map').GenuiMap;
let parseGenui: typeof import('@kortix/sdk/genui').parseGenui;
let mapStyleUrl: typeof import('./components/map').mapStyleUrl;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Bun loads apps/mobile/.env: a local style URL must not add an Open map row to the env-default render.
  delete process.env.EXPO_PUBLIC_GENUI_MAP_STYLE_URL;
  ({ GenuiMessageBlock } = await import('./genui-message-block'));
  ({ GenuiMap, mapStyleUrl } = await import('./components/map'));
  ({ parseGenui } = await import('@kortix/sdk/genui'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  opened.length = 0;
  mockDark = false;
});

function render(code: string) {
  act(() => {
    tree = create(
      <GenuiMessageBlock code={code} version={1} isStreaming={false} renderMarkdown={(md) => React.createElement('fallback', null, md)} />,
    );
  });
  return tree!.root;
}

/** The Map node of real source, rendered alone with an explicit style env value (`''` = unset, `'off'` = no map). */
function renderMap(code: string, styleUrl: string, streaming = false) {
  const map = (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
  act(() => {
    tree = create(<GenuiMap node={map} props={map.props} renderChild={() => null} streaming={streaming} styleUrl={styleUrl} />);
  });
  return tree!.root;
}

/** A Map node built by hand, for marker values the parser would already refuse. */
function renderNodes(markers: Record<string, unknown>[], styleUrl: string) {
  const nodes = markers.map((props, i) => ({ id: `m${i}`, type: 'Marker', props }) as unknown as GenuiNode);
  const map = { id: 'map', type: 'Map', props: { markers: nodes, source: 'tool' } } as unknown as GenuiNode;
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

const OSM_DEFAULT = 'https://tiles.openfreemap.org/styles/positron';
/** The inline map: the Pressable that opens the full-screen sheet. */
const inlineMap = (root: ReactTestInstance) => all(root, 'pressable').filter((n) => String(n.props.accessibilityLabel ?? '').startsWith('Open map'));

describe('mobile genui Map', () => {
  test('the basemap defaults to OpenFreeMap per theme; the env overrides it for both; off turns the map off', () => {
    expect(mapStyleUrl(false, undefined)).toBe(OSM_DEFAULT);
    expect(mapStyleUrl(true, '')).toBe('https://tiles.openfreemap.org/styles/dark');
    expect(mapStyleUrl(true, STYLE_URL)).toBe(STYLE_URL);
    expect(mapStyleUrl(false, 'off')).toBeNull();
  });

  test('the map shows inline as a still picture, as on web: no place rows, no Directions, no Open map row', () => {
    const root = render(TWO_PLACES);
    expect(all(root, 'fallback')).toHaveLength(0);
    const [map] = inlineMap(root);
    expect(map!.props.accessibilityLabel).toBe('Open map: Louvre, Opera');
    expect(map!.props.style).toEqual({ height: 320 });
    const [view] = all(map!, 'map-webview');
    expect(view!.props.interactive).toBe(false);
    // The still map takes no touches, so the transcript keeps its scroll.
    expect(all(map!, 'view')[0]!.props.pointerEvents).toBe('none');
    expect(all(root, 'button')).toHaveLength(0);
    expect(all(root, 'settings-row')).toHaveLength(0);
    expect(texts(root)).toEqual([]);
  });

  test('the pins carry the marker value; dark mode takes the dark style', () => {
    let root = renderMap(
      `root = Stack([m])
m = Map([a], "places tool")
a = Marker(19.04, 72.82, "Taj Lands End", "Bandstand", "★ 4.6")`,
      '',
    );
    const data = all(root, 'map-webview')[0]!.props.data as { styleUrl: string; markers: { value?: string }[] };
    expect(data.styleUrl).toBe(OSM_DEFAULT);
    expect(data.markers[0]!.value).toBe('★ 4.6');
    act(() => tree?.unmount());
    mockDark = true;
    root = renderMap(TWO_PLACES, '');
    expect((all(root, 'map-webview')[0]!.props.data as { styleUrl: string }).styleUrl).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  test('with the map off there is no map, only the places as rows, each with Directions', () => {
    const root = renderMap(TWO_PLACES, 'off');
    expect(inlineMap(root)).toHaveLength(0);
    expect(all(root, 'map-webview')).toHaveLength(0);
    expect(texts(root)).toEqual(['Louvre', 'Museum', 'Directions', 'Opera', 'Directions']);
    expect(all(root, 'button')).toHaveLength(2);
  });

  test('a map-off row has Directions, Website, and Call; each opens its link, Call as tel:', () => {
    const root = renderMap(
      `root = Stack([m])
m = Map([a, b], "places tool")
a = Marker(19.04, 72.82, "Taj Lands End", "Bandstand", "★ 4.6", "https://taj.example.com/", "https://img.example.com/taj.jpg", "+91 22 6668-1234", "Hotel")
b = Marker(19.05, 72.83, "Kiosk", null, null, null, null, "12")`,
      'off',
    );
    const buttons = all(root, 'button');
    expect(buttons.map((b) => texts(b))).toEqual([['Directions'], ['Website'], ['Call'], ['Directions']]);
    expect(buttons.map((b) => b.props.variant)).toEqual(['default', 'secondary', 'secondary', 'default']);
    for (const button of buttons) press(button);
    expect(opened).toEqual([
      'https://www.google.com/maps/dir/?api=1&destination=19.04,72.82',
      'https://taj.example.com/',
      'tel:+912266681234',
      'https://www.google.com/maps/dir/?api=1&destination=19.05,72.83',
    ]);
  });

  test('while its block streams the map holds the pending block and builds no WebView; it builds once it settles', () => {
    const map = (parseGenui(TWO_PLACES).root!.props.children as GenuiNode[])[0]!;
    const el = (streaming: boolean) => <GenuiMap node={map} props={map.props} renderChild={() => null} streaming={streaming} styleUrl={STYLE_URL} />;
    act(() => {
      tree = create(el(true));
    });
    let root = tree!.root;
    expect(all(root, 'map-webview')).toHaveLength(0);
    expect(inlineMap(root)).toHaveLength(0);
    const [pending] = all(root, 'view');
    expect(pending!.props.style).toEqual({ height: 320 });
    expect(all(root, 'loader')).toHaveLength(1);
    act(() => tree!.update(el(false)));
    root = tree!.root;
    expect(all(root, 'loader')).toHaveLength(0);
    expect(all(root, 'map-webview')).toHaveLength(1);
  });

  test('with the map off a streaming map is already its rows: there is no WebView to wait for', () => {
    const root = renderMap(TWO_PLACES, 'off', true);
    expect(texts(root)).toContain('Louvre');
    expect(all(root, 'loader')).toHaveLength(0);
  });

  test('a marker with a missing or out-of-range coordinate is dropped', () => {
    const root = renderNodes(
      [
        { lat: 48.85, lng: 2.35, label: 'Louvre' },
        { lat: 91, lng: 2.35, label: 'North of north' },
        { lat: 48.85, lng: -181, label: 'Off the date line' },
        { lng: 2.35, label: 'No latitude' },
        { lat: '48.85', lng: 2.35, label: 'A string' },
        { lat: -90, lng: 180, label: 'Edge' },
      ],
      STYLE_URL,
    );
    const data = all(root, 'map-webview')[0]!.props.data as { markers: { label: string }[] };
    expect(data.markers.map((m) => m.label)).toEqual(['Louvre', 'Edge']);
  });

  test('a tap on the map opens it full screen with every place, route, and zoom; closing unmounts it', () => {
    const root = renderMap(TWO_PLACES, STYLE_URL);
    expect(all(root, 'map-sheet')).toHaveLength(0);
    press(inlineMap(root)[0]!);
    const [sheet] = all(root, 'map-sheet');
    expect(sheet!.props.title).toBe('Map');
    expect(sheet!.props.data).toEqual({
      styleUrl: STYLE_URL,
      markers: [
        { id: 'a', lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' },
        { id: 'b', lat: 48.86, lng: 2.36, label: 'Opera' },
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

  test('every marker field the catalog defines reaches the map: href, image, phone, kind', () => {
    const root = renderMap(
      `root = Stack([m])
m = Map([a], "places tool")
a = Marker(19.04, 72.82, "Taj Lands End", "Bandstand", "★ 4.6", "https://taj.example.com/", "https://img.example.com/taj.jpg", "+91 22 6668-1234", "Hotel")`,
      STYLE_URL,
    );
    const data = all(root, 'map-webview')[0]!.props.data as { markers: unknown[] };
    expect(data.markers).toEqual([
      {
        id: 'a',
        lat: 19.04,
        lng: 72.82,
        label: 'Taj Lands End',
        description: 'Bandstand',
        value: '★ 4.6',
        href: 'https://taj.example.com/',
        image: 'https://img.example.com/taj.jpg',
        phone: '+91 22 6668-1234',
        kind: 'Hotel',
      },
    ]);
  });

  test('a map of one place titles its sheet with that place', () => {
    const root = renderMap(
      `root = Stack([m])
m = Map([a], "places tool")
a = Marker(48.85, 2.35, "Louvre")`,
      STYLE_URL,
    );
    press(inlineMap(root)[0]!);
    expect(all(root, 'map-sheet')[0]!.props.title).toBe('Louvre');
  });

  test('a basemap that fails swaps the inline map for the place rows, with their buttons, as with the map off', () => {
    const root = renderMap(TWO_PLACES, STYLE_URL);
    act(() => (all(root, 'map-webview')[0]!.props.onFail as () => void)());
    expect(inlineMap(root)).toHaveLength(0);
    expect(all(root, 'map-webview')).toHaveLength(0);
    expect(texts(root)).toEqual(['Louvre', 'Museum', 'Directions', 'Opera', 'Directions']);
    press(all(root, 'button')[1]!);
    expect(opened).toEqual(['https://www.google.com/maps/dir/?api=1&destination=48.86,2.36']);
  });

  test('a row offers Website only for an http(s) link, as the popup does', () => {
    const root = renderNodes(
      [
        { lat: 48.85, lng: 2.35, label: 'Louvre', href: 'javascript:alert(1)' },
        { lat: 48.86, lng: 2.36, label: 'Opera', href: 'https://opera.example.com/' },
      ],
      'off',
    );
    expect(all(root, 'button').map((b) => texts(b))).toEqual([['Directions'], ['Directions'], ['Website']]);
  });

  test('a map whose every marker is dropped keeps a block that says the map is unavailable, map on or off', () => {
    for (const styleUrl of [STYLE_URL, 'off']) {
      const root = renderNodes([{ lat: 91, lng: 2.35, label: 'North of north' }], styleUrl);
      expect(all(root, 'map-webview')).toHaveLength(0);
      expect(texts(root)).toEqual(['Map unavailable']);
      act(() => tree?.unmount());
      tree = undefined;
    }
  });
});
