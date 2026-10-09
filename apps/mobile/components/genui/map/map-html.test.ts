import { describe, expect, test } from 'bun:test';

import { mapDocument, scriptJson, type MapDocumentInput } from './map-html';

type Camera = Record<string, unknown> & { bounds?: { points: number[][] } };

/** Runs the page's own script against a recording stand-in for maplibregl, the way the WebView would. */
function runPage(input: Partial<MapDocumentInput>) {
  const html = mapDocument({ script: '', css: '', styleUrl: 's', markers: [], background: 'white', routeColor: 'black', ...input });
  const page = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const seen = { camera: null as Camera | null, markers: [] as number[][], popups: [] as string[][], layers: [] as unknown[] };
  let onLoad = () => {};
  const element = () => {
    const el = { className: '', textContent: '', children: [] as { textContent: string }[] };
    return Object.assign(el, { appendChild: (child: { textContent: string }) => el.children.push(child) });
  };
  const maplibregl = {
    LngLatBounds: class {
      points: number[][] = [];
      extend(point: number[]) {
        this.points.push(point);
      }
    },
    Map: class {
      constructor(camera: Camera) {
        seen.camera = camera;
      }
      addControl() {}
      on(_event: string, handler: () => void) {
        onLoad = handler;
      }
      addSource() {}
      addLayer(layer: unknown) {
        seen.layers.push(layer);
      }
    },
    NavigationControl: class {},
    Popup: class {
      setDOMContent(el: ReturnType<typeof element>) {
        seen.popups.push([el.children[0]!.textContent, ...el.children.slice(1).map((c) => c.textContent)]);
        return this;
      }
    },
    Marker: class {
      setLngLat(point: number[]) {
        seen.markers.push(point);
        return this;
      }
      setPopup() {
        return this;
      }
      addTo() {
        return this;
      }
    },
  };
  new Function('maplibregl', 'document', page)(maplibregl, { createElement: element });
  onLoad();
  return seen;
}

describe('map document', () => {
  test('model text cannot close the script tag', () => {
    const json = scriptJson({ label: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).label).toBe('</script><script>alert(1)</script>');
  });

  test('line and paragraph separators are escaped', () => {
    const raw = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const json = scriptJson(raw);
    expect(json).toBe('"a\\u2028b\\u2029c"');
    expect(JSON.parse(json)).toBe(raw);
  });

  test('builds a document with markers as [lng, lat] and the route converted', () => {
    const html = mapDocument({
      script: 'var maplibregl = {};',
      css: '.x{}',
      styleUrl: 'https://tiles.example.com/style.json',
      markers: [{ lat: 48.85, lng: 2.35, label: '</script>evil' }],
      route: [[48.85, 2.35], [48.86, 2.36]],
      background: 'rgb(255,255,255)',
      routeColor: 'rgba(0,0,0,0.7)',
    });
    expect(html).toContain('"lngLat":[2.35,48.85]');
    expect(html).toContain('"route":[[2.35,48.85],[2.36,48.86]]');
    expect(html).not.toContain('</script>evil');
    expect(html).toContain('https://tiles.example.com/style.json');
    expect(html).toContain('"routeColor":"rgba(0,0,0,0.7)"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test('a script asset containing </script> cannot break out', () => {
    const html = mapDocument({ script: 'x="</script>"', css: '', styleUrl: 's', markers: [], background: 'white', routeColor: 'black' });
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  test('one place opens centred on it at the given zoom, its popup shows the label and description', () => {
    const seen = runPage({ markers: [{ lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' }], zoom: 12 });
    expect(seen.camera).toMatchObject({ center: [2.35, 48.85], zoom: 12, style: 's', container: 'map' });
    expect(seen.markers).toEqual([[2.35, 48.85]]);
    expect(seen.popups).toEqual([['Louvre', 'Museum']]);
    expect(seen.layers).toEqual([]);
  });

  test('several places and the route are all inside the first frame; the route draws as a line', () => {
    const seen = runPage({
      markers: [
        { lat: 48.85, lng: 2.35, label: 'A' },
        { lat: 48.86, lng: 2.36, label: 'B' },
      ],
      route: [[48.8, 2.3], [48.9, 2.4]],
    });
    expect(seen.camera?.bounds?.points).toEqual([[2.35, 48.85], [2.36, 48.86], [2.3, 48.8], [2.4, 48.9]]);
    expect(seen.camera?.fitBoundsOptions).toEqual({ padding: 48, maxZoom: 16 });
    expect(seen.layers).toEqual([expect.objectContaining({ type: 'line', paint: { 'line-width': 3, 'line-color': 'black' } })]);
  });
});
