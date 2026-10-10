import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into map nodes
import { parseGenui } from '@kortix/sdk/genui';

import { createTranslator } from 'next-intl';

import { MAP_DEFAULTS } from '@/components/ui/map';

import en from '../../../../translations/en.json';
import type { GenuiNode } from '../sdk';
import { GenuiMapView } from './map';
import { canvasOptions, paintRgb } from './map-canvas';
import { mapBounds, routeCoordinates } from './map-geo';
import { GenuiPending } from './pending';

/** The first block inside `root = Stack([...])`. */
const node = (code: string) => (parseGenui(code).root!.props.children as GenuiNode[])[0]!;
const map = node('root = Stack([m])\nm = Map([a, b], "places tool")\na = Marker(48.85, 2.35, "A")\nb = Marker(48.86, 2.36, "B", "Second")');
const render = (styleUrl: string | undefined) =>
  renderToStaticMarkup(<GenuiMapView node={map} props={map.props} renderChild={() => null} streaming={false} styleUrl={styleUrl} />);

const STYLE_ENV = 'NEXT_PUBLIC_GENUI_MAP_STYLE_URL';
const savedStyle = process.env[STYLE_ENV];
afterEach(() => {
  if (savedStyle === undefined) delete process.env[STYLE_ENV];
  else process.env[STYLE_ENV] = savedStyle;
});

describe('genui map', () => {
  test('without a configured style, renders each place as an OpenStreetMap link, its description, and the source', () => {
    const html = render(undefined);
    expect(html).toContain('href="https://www.openstreetmap.org/?mlat=48.86&amp;mlon=2.36#map=15/48.86/2.36"');
    expect(html).toMatch(/>B<\/a>/);
    expect(html).toContain('Second');
    expect(html).toContain('Source: places tool');
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

  test('with a style, the pending block and the settled figure are one height, and only the map box has a border', () => {
    process.env[STYLE_ENV] = 'https://tiles.example.test/style.json';
    const settled = render('https://tiles.example.test/style.json');
    const figureHeight = settled.match(/<figure[^>]*class="[^"]*(min-h-\[\d+px\])/)?.[1];
    expect(figureHeight).toBe('min-h-[304px]');
    expect(settled).toMatch(/<figure[^>]*class="(?![^"]*\bborder\b)[^"]*"/);
    expect(settled).toContain('h-[280px]');
    // One line, full text on hover: a wrapped caption would grow past the reserved height.
    expect(settled).toMatch(/<figcaption[^>]*class="[^"]*\btruncate\b[^"]*"[^>]*title="Source: places tool"[^>]*>Source: places tool<\/figcaption>/);

    const pending = renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>);
    expect(pending).toContain(figureHeight!);
    expect(pending).toMatch(/class="[^"]*\bh-\[280px\][^"]*\bborder\b/);
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
      expect(html).toContain('min-h-[304px]');
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain('<figcaption');
    }
  });

  test('without a style, a pending map waits invisibly, like text: the place list has no fixed height to reserve', () => {
    delete process.env[STYLE_ENV];
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
});
