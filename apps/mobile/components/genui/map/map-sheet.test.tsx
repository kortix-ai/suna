/**
 * The full-screen map: it reads the bundled MapLibre assets, then loads one inline document into a
 * locked-down WebView. Native modules are host stubs. Run with `bun test --isolate`.
 */
import { afterEach, beforeAll, describe, expect, jest, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host = (name: string) => ({ children, ...props }: HostProps) => React.createElement(name, props, children);

const files = { fail: false, reads: [] as string[] };
const opened: string[] = [];

mock.module('react-native', () => ({
  View: host('view'),
  Text: host('rntext'),
  ScrollView: host('scroll'),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
mock.module('react-native-webview', () => ({ WebView: host('webview') }));
mock.module('@/assets/maplibre/maplibre-gl.webjs', () => ({ default: 'script-asset' }));
mock.module('@/assets/maplibre/maplibre-gl-css.webjs', () => ({ default: 'css-asset' }));
mock.module('expo-asset', () => ({
  Asset: { fromModule: (id: { default: string }) => ({ downloadAsync: async () => ({ localUri: `file:///${id.default}`, uri: '' }) }) },
}));
mock.module('expo-file-system', () => ({
  File: class {
    constructor(private uri: string) {}
    async text() {
      files.reads.push(this.uri);
      if (files.fail) throw new Error('read failed');
      return this.uri.includes('script') ? 'window.maplibregl = {};' : '.maplibregl-map{}';
    }
  },
}));
mock.module('expo-router/react-navigation', () => ({ DefaultTheme: {}, DarkTheme: {} }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'dark' }) }));
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: host('dialog'),
  DialogContent: host('dialog-content'),
  DialogTitle: host('dialog-title'),
  DialogClose: host('dialog-close'),
}));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/separator', () => ({ Separator: host('separator') }));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: host('loader') }));
mock.module('@/lib/icons', () => ({ XIcon: 'x' }));
mock.module('@/lib/utils/open-link', () => ({
  openExternalLink: (href: string) => opened.push(href),
  openLink: async (href: string) => {
    opened.push(href);
  },
}));

let MapSheet: typeof import('./map-sheet').MapSheet;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ MapSheet } = await import('./map-sheet'));
});

let tree: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  files.fail = false;
  files.reads.length = 0;
  opened.length = 0;
  jest.useRealTimers();
});

const DATA = {
  styleUrl: 'https://tiles.example.com/style.json',
  markers: [
    { id: 'a', lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' },
    { id: 'b', lat: 19.04, lng: 72.82, label: 'Taj', href: 'https://taj.example.com/', phone: '+91 22 6668-1234' },
  ],
  route: [
    [48.85, 2.35],
    [48.86, 2.36],
  ] as [number, number][],
};
const closed: number[] = [];

async function open(Sheet: typeof MapSheet = MapSheet) {
  await act(async () => {
    tree = create(<Sheet title="Louvre" data={DATA} onClose={() => closed.push(1)} />);
  });
  return tree!.root;
}
const all = (root: ReactTestInstance, type: string) => root.findAll((n) => n.type === (type as never));
const texts = (root: ReactTestInstance) => all(root, 'text').flatMap((n) => n.children.filter((c) => typeof c === 'string'));
/** The place rows: what a failed basemap shows in its place, with every button. */
const ROWS = ['Louvre', 'Museum', 'Directions', 'Taj', 'Directions', 'Website', 'Call'];
const send = (root: ReactTestInstance, data: unknown) =>
  act(() => (all(root, 'webview')[0]!.props.onMessage as (event: { nativeEvent: { data: string } }) => void)({ nativeEvent: { data: JSON.stringify(data) } }));

describe('MapSheet', () => {
  test('a failed asset read shows the place rows, and the next open reads again', async () => {
    files.fail = true;
    const root = await open();
    expect(all(root, 'webview')).toHaveLength(0);
    expect(texts(root)).toEqual(ROWS);
    act(() => tree!.unmount());
    files.fail = false;
    files.reads.length = 0;
    const again = await open();
    expect(files.reads).toEqual(['file:///script-asset', 'file:///css-asset']);
    expect(all(again, 'webview')).toHaveLength(1);
  });

  test('the WebView loads only the inline map document, private and uncached, in theme colors', async () => {
    const root = await open();
    expect(all(root, 'dialog-title')[0]!.children).toEqual(['Louvre']);
    const [webview] = all(root, 'webview');
    const { html, baseUrl } = webview!.props.source as { html: string; baseUrl: string };
    expect(baseUrl).toBe('');
    expect(html).toContain('window.maplibregl = {};');
    expect(html).toContain('.maplibregl-map{}');
    expect(html).toContain('"lngLat":[2.35,48.85]');
    expect(html).toContain('https://tiles.example.com/style.json');
    // Dark theme: the dialog's popover surface behind the tiles; the route is the charts' first series (--chart-3).
    expect(html).toContain('background:hsla(0, 0%, 7.8%, 1)');
    expect(html).toContain('"routeColor":"hsla(30.1, 100%, 44.1%, 1)"');
    // The popup's buttons are translated.
    expect(html).toContain('"labels":{"directions":"Directions","website":"Website","call":"Call"}');
    const load = webview!.props.onShouldStartLoadWithRequest as (request: { url: string; isTopFrame?: boolean }) => boolean;
    expect(load({ url: 'about:blank' })).toBe(true);
    expect(load({ url: 'javascript:alert(1)' })).toBe(false);
    expect(opened).toEqual([]);
    expect(webview!.props.originWhitelist).toEqual(['*']);
    expect([webview!.props.incognito, webview!.props.cacheEnabled, webview!.props.javaScriptEnabled]).toEqual([true, false, true]);
  });

  test('an attribution link opens in the browser, whether it targets the page or a new window; nothing else leaves the app', async () => {
    const root = await open();
    const [webview] = all(root, 'webview');
    const load = webview!.props.onShouldStartLoadWithRequest as (request: { url: string; isTopFrame?: boolean }) => boolean;
    const openWindow = webview!.props.onOpenWindow as (event: { nativeEvent: { targetUrl: string } }) => void;
    expect(load({ url: 'https://www.openstreetmap.org/copyright', isTopFrame: true })).toBe(false);
    openWindow({ nativeEvent: { targetUrl: 'https://maplibre.org/' } });
    // An iframe load and a non-web scheme open nothing.
    expect(load({ url: 'https://tracker.example.com/', isTopFrame: false })).toBe(false);
    openWindow({ nativeEvent: { targetUrl: 'intent://evil' } });
    expect(opened).toEqual(['https://www.openstreetmap.org/copyright', 'https://maplibre.org/']);
  });

  test('the asset is read once per app run, and dismissing the dialog closes the sheet', async () => {
    // A fresh module instance starts with an empty cache, whatever ran before this test.
    const cold: string = './map-sheet?cold';
    const { MapSheet: Cold } = (await import(cold)) as typeof import('./map-sheet');
    await open(Cold);
    act(() => tree!.unmount());
    const root = await open(Cold);
    expect(files.reads).toEqual(['file:///script-asset', 'file:///css-asset']);
    expect(all(root, 'webview')).toHaveLength(1);
    act(() => (all(root, 'dialog')[0]!.props.onOpenChange as (open: boolean) => void)(false));
    expect(closed).toEqual([1]);
  });

  test("a popup action reaches native through the message bridge and opens that place's link; anything else opens nothing", async () => {
    const root = await open();
    const message = all(root, 'webview')[0]!.props.onMessage as (event: { nativeEvent: { data: string } }) => void;
    const send = (data: unknown) => message({ nativeEvent: { data: typeof data === 'string' ? data : JSON.stringify(data) } });
    send({ type: 'place', index: 0, action: 'directions' });
    send({ type: 'place', index: 1, action: 'website' });
    send({ type: 'place', index: 1, action: 'call' });
    // A place without a website or phone, an unknown index or action, and junk open nothing.
    send({ type: 'place', index: 0, action: 'website' });
    send({ type: 'place', index: 0, action: 'call' });
    send({ type: 'place', index: 7, action: 'directions' });
    send({ type: 'place', index: '1', action: 'website' });
    send({ type: 'place', index: 1, action: 'open' });
    send({ type: 'other', index: 0, action: 'directions' });
    send('not json');
    expect(opened).toEqual([
      'https://www.google.com/maps/dir/?api=1&destination=48.85,2.35',
      'https://taj.example.com/',
      'tel:+912266681234',
    ]);
  });

  test('a basemap that fails in the page swaps the map for the place rows, with their buttons', async () => {
    const root = await open();
    // Unknown states and types change nothing.
    send(root, { type: 'map', state: 'broken' });
    send(root, { type: 'mapx', state: 'error' });
    expect(all(root, 'webview')).toHaveLength(1);
    send(root, { type: 'map', state: 'error' });
    expect(all(root, 'webview')).toHaveLength(0);
    expect(texts(root)).toEqual(ROWS);
    // The rows' buttons work.
    const directions = all(root, 'button').find((b) => b.props.accessibilityLabel === 'Directions: Louvre')!;
    act(() => (directions.props.onPress as () => void)());
    expect(opened).toEqual(['https://www.google.com/maps/dir/?api=1&destination=48.85,2.35']);
  });

  for (const handler of ['onError', 'onHttpError'] as const) {
    test(`a WebView ${handler} swaps the map for the place rows`, async () => {
      const root = await open();
      act(() => (all(root, 'webview')[0]!.props[handler] as (event: unknown) => void)({ nativeEvent: {} }));
      expect(all(root, 'webview')).toHaveLength(0);
      expect(texts(root)).toEqual(ROWS);
    });
  }

  test('no load within 10 s counts as a failure; a map that loads in time stays', async () => {
    jest.useFakeTimers();
    let root = await open();
    act(() => {
      jest.advanceTimersByTime(9_999);
    });
    expect(all(root, 'webview')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(all(root, 'webview')).toHaveLength(0);
    expect(texts(root)).toEqual(ROWS);
    act(() => tree!.unmount());
    root = await open();
    send(root, { type: 'map', state: 'load' });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(all(root, 'webview')).toHaveLength(1);
  });
});
