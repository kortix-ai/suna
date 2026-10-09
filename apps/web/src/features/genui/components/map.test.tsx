import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// eslint-disable-next-line no-restricted-imports -- the test parses real OpenUI source into map nodes
import { parseGenui } from '@kortix/sdk/genui';

import type { GenuiNode } from '../sdk';
import { GenuiMapView, mapBounds, routeCoordinates } from './map';
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
    expect(settled).toMatch(/<figcaption[^>]*>Source: places tool<\/figcaption>/);

    const pending = renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>);
    expect(pending).toContain(figureHeight!);
    expect(pending).toMatch(/class="[^"]*\bh-\[280px\][^"]*\bborder\b/);
  });

  test('without a style, a pending map waits invisibly, like text: the place list has no fixed height to reserve', () => {
    delete process.env[STYLE_ENV];
    expect(renderToStaticMarkup(<>{GenuiPending({ id: 'm', type: 'Map', props: {}, partial: true })}</>)).toBe('');
  });
});
