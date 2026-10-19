import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into map nodes
import { parseGenui } from '@kortix/sdk/genui';

import { createTranslator } from 'use-intl';

import { MAP_DEFAULTS, watchMapLoad } from '../../../../components/ui/map';
import { setUiHostEnv } from '../../../../lib/host-env';

import { defaultUiMessages as en } from '../../../../i18n';
import type { GenuiNode } from '../sdk';
import { GenuiMapView } from './map';
import { canvasOptions, paintRgb } from './map-canvas';
import { mapBounds, mapStyles, pinValue, routeCoordinates, telLink } from './map-geo';
import { GenuiPending, MAP_BOX, MAP_FIGURE_HEIGHT } from './pending';

/** The first block inside `root = Stack([...])`. */
const node = (code: string) => (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
const map = node('root = Stack([m])\nm = Map([a, b], "places tool")\na = Marker(48.85, 2.35, "A")\nb = Marker(48.86, 2.36, "B", "Second")');
const render = (styleUrl: string | undefined) =>
  renderToStaticMarkup(<GenuiMapView node={map} props={map.props} renderChild={() => null} streaming={false} styleUrl={styleUrl} />);

const STYLE_ENV = 'NEXT_PUBLIC_GENUI_MAP_STYLE_URL';
const savedStyle = process.env[STYLE_ENV];
// The web host reads the map style from the env; the test sets the env per case.
setUiHostEnv(() => ({ mapStyleUrl: process.env[STYLE_ENV] }));
afterEach(() => {
  if (savedStyle === undefined) delete process.env[STYLE_ENV];
  else process.env[STYLE_ENV] = savedStyle;
});

describe('genui map', () => {
  test('without a configured style, renders each place as a row: name, description, and Directions (no coordinates, no Copy)', () => {
    const html = render(undefined);
    expect(html).toMatch(/<a href="https:\/\/www.google.com\/maps\/dir\/\?api=1&amp;destination=48.86,2.36"[^>]*>Directions<\/a>/);
    expect(html).toMatch(/>B<\/span>/);
    expect(html).not.toContain('48.8600, 2.3600');
    expect(html).not.toMatch(/>Copy</);
    expect(html).toContain('Second');
    // No visible source line: the source lives only in the figure's screen-reader label.
    expect(html).not.toContain('<figcaption');
    expect(html).toContain('aria-label="Map with 2 places: A, B. Source: places tool"');
    expect(html).not.toContain('min-h-[');
  });

  test('bounds cover every marker as [lng, lat]', () => {
    expect(
      mapBounds([
        { lat: 48.85, lng: 2.35 },
        { lat: 48.86, lng: 2.36 },
      ]),
    ).toEqual([
      [2.35, 48.85],
      [2.36, 48.86],
    ]);
  });

  test('route points in GeoJSON order or non-finite are dropped; the rest become [lng, lat]', () => {
    // [-122.4, 37.7] is [lng, lat]: latitude -122.4 is out of range and would make MapLibre throw.
    expect(routeCoordinates([[37.7, -122.4], [-122.4, 37.7], [Number.NaN, 1], [37.8, -122.5], [10, 181]])).toEqual([
      [-122.4, 37.7],
      [-122.5, 37.8],
    ]);
    expect(routeCoordinates([[37.7, -122.4], [-122.4, 37.7]])).toBeUndefined();
    expect(routeCoordinates(undefined)).toBeUndefined();
    expect(routeCoordinates('not a route')).toBeUndefined();
  });

  test('with a style, the map is the whole card: the MAP_BOX well the pending block reserves, no place rows under it', () => {
    process.env[STYLE_ENV] = 'https://tiles.example.test/style.json';
    const settled = render('https://tiles.example.test/style.json');
    expect(settled).toMatch(/<figure[^>]*class="(?![^"]*\bborder\b)[^"]*"/);
    // The well is MAP_BOX, the box the pending block reserves (its height lives in pending.tsx).
    const boxHeight = MAP_BOX.match(/h-\[\d+px\]/)![0];
    expect(settled).toContain(`${boxHeight} w-full overflow-hidden bg-card rounded-md border-0`);
    // The pins carry the names; the rows and their Directions buttons show only with the map off.
    expect(settled).not.toMatch(/>Directions<\/a>/);

    const pending = renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>);
    expect(pending).toContain(boxHeight);
  });

  test('with a style, a streaming map holds the reserved box until its block settles, whatever its markers', () => {
    process.env[STYLE_ENV] = 'https://tiles.example.test/style.json';
    // Streamed top-down, the Map statement completes before its Marker lines: 0 markers.
    const empty: GenuiNode = { ...map, props: { ...map.props, markers: [] } };
    for (const streamed of [empty, map]) {
      const html = renderToStaticMarkup(
        <GenuiMapView node={streamed} props={streamed.props} renderChild={() => null} streaming styleUrl="https://tiles.example.test/style.json" />,
      );
      // The pending block: same figure height, the spinner, no canvas and no place list yet.
      expect(html).toContain(MAP_FIGURE_HEIGHT);
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain('<figcaption');
    }
  });

  test('with the map switched off, a pending map waits invisibly, like text: the place rows have no fixed height to reserve', () => {
    process.env[STYLE_ENV] = 'off';
    expect(renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>)).toBe('');
  });

  test('on touch, one finger scrolls the chat and two fingers move the map; the wheel never zooms', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'genui' });
    const options = canvasOptions((key) => t(key as never));
    expect(options.cooperativeGestures).toBe(true);
    expect(options.scrollZoom).toBe(false);
    expect(options.locale).toEqual({ 'Map.Title': 'Map', 'CooperativeGesturesHandler.MobileHelpText': 'Use two fingers to move the map' });
  });

  test('the attribution stays expanded: the tile license text is always visible', () => {
    expect(MAP_DEFAULTS.attributionControl).toEqual({ compact: false });
  });

  test('the route color falls back to the next token, then to a fixed grey, never to nothing', () => {
    expect(paintRgb(null, ['oklch(0.66 0.17 53)'])).toBe('gray');
    // A fake 2D context: a value it cannot parse leaves the pixel transparent, as a canvas does.
    const painted: string[] = [];
    let fill = 'transparent';
    const context = {
      clearRect: () => painted.splice(0),
      set fillStyle(value: string) {
        if (value === 'transparent' || value.startsWith('#') || value.startsWith('rgb')) fill = value;
      },
      fillRect: () => painted.push(fill),
      getImageData: () => ({ data: painted.at(-1) === 'rgb(31, 31, 31)' ? [31, 31, 31, 255] : [0, 0, 0, 0] }),
    };
    expect(paintRgb(context as never, ['oklch(0.66 0.17 53)', 'rgb(31, 31, 31)'])).toBe('rgb(31, 31, 31)');
    expect(paintRgb(context as never, ['', 'not a color'])).toBe('gray');
  });

  test('the basemap defaults to OpenFreeMap; the env overrides it, and off switches the map off', () => {
    delete process.env[STYLE_ENV];
    expect(mapStyles()).toEqual({ light: 'https://tiles.openfreemap.org/styles/positron', dark: 'https://tiles.openfreemap.org/styles/dark' });
    expect(renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>)).toContain(MAP_BOX.match(/h-\[\d+px\]/)![0]);
    process.env[STYLE_ENV] = 'https://tiles.example.test/style.json';
    expect(mapStyles()?.light).toBe('https://tiles.example.test/style.json');
    process.env[STYLE_ENV] = 'off';
    expect(mapStyles()).toBeNull();
  });

  test('Call dials the digits of a written phone number; nothing to dial gives no link', () => {
    expect(telLink('+91 22 6668 1234')).toBe('tel:+912266681234');
    expect(telLink('(030) 123-4567')).toBe('tel:0301234567');
    expect(telLink('call us')).toBeNull();
    expect(telLink(undefined)).toBeNull();
  });

  test('a pin shows a value only when it is a figure; a category word keeps the plain dot', () => {
    for (const figure of ['★ 4.7', '₹24,000', '1.2M', '$199 a night']) expect(pinValue(figure)).toBe(figure);
    for (const word of ['Luxury', 'Boutique', '', undefined]) expect(pinValue(word)).toBeUndefined();
  });

  test('a map whose style fails before it loads reports a failure once; a tile error after the style loaded does not', () => {
    const fake = () => {
      const handlers: Record<string, Set<() => void>> = {};
      return {
        on: (type: string, fn: () => void) => void (handlers[type] ??= new Set()).add(fn),
        off: (type: string, fn: () => void) => void handlers[type]?.delete(fn),
        fire: (type: string) => handlers[type]?.forEach((fn) => fn()),
        count: () => Object.values(handlers).reduce((n, set) => n + set.size, 0),
      };
    };
    const calls: string[] = [];
    const gates = { load: () => calls.push('load'), styleLoad: () => calls.push('style'), fail: () => calls.push('fail') };

    const broken = fake();
    watchMapLoad(broken, gates);
    broken.fire('error');
    expect(calls).toEqual(['fail']);

    calls.length = 0;
    const flaky = fake();
    const stop = watchMapLoad(flaky, gates);
    flaky.fire('style.load');
    flaky.fire('error');
    flaky.fire('load');
    flaky.fire('error');
    expect(calls).toEqual(['style', 'load']);
    stop();
    expect(flaky.count()).toBe(0);
  });
});
