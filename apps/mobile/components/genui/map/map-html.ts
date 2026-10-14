/** The map document for react-native-webview, inline in the transcript or full screen. Pure: unit-tested under Bun. */

import { escapeForInlineScript } from '@/lib/utils/html-embed';

export interface MapDocumentInput {
  /** maplibre-gl.js source, loaded from the bundled asset. */
  script: string;
  /** maplibre-gl.css source. */
  css: string;
  styleUrl: string;
  /** `value` is the figure in the pin (a rating, a price); a pin shows it only when it holds a digit, as on web. */
  markers: { lat: number; lng: number; label: string; description?: string; value?: string }[];
  /** [lat, lng] pairs, as the catalog stores them. */
  route?: [number, number][];
  zoom?: number;
  /** Page background and route color: theme tokens through `withAlpha`, never hex (mobile AGENTS.md). */
  background: string;
  routeColor: string;
  /** Pin colors (web's MapPin): the surface bubble, its ink, and its hairline. */
  pin: { surface: string; ink: string; border: string; shadow: string };
  /** false: a still picture for the transcript (no pan, zoom, controls, or popups); the full-screen map is interactive. */
  interactive?: boolean;
}

/** Only a figure goes in a pin (a rating, a price); a word ("Luxury") does not, as web's `pinValue`. */
export const pinValue = (value: string | undefined): string | undefined => (value && /\d/.test(value) ? value : undefined);

/**
 * JSON that is safe inside an inline <script>: `</script>` and U+2028/U+2029 cannot end or change the
 * script, so model text stays data. Every model-supplied value reaches the page through this.
 */
export function scriptJson(value: unknown): string {
  return escapeForInlineScript(JSON.stringify(value));
}

const onGlobe = ([lat, lng]: [number, number]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export function mapDocument(input: MapDocumentInput): string {
  // The catalog checks a route point's length, not its range: MapLibre throws on an off-globe point
  // (GeoJSON order written by mistake) before the map exists. Such points drop; under 2 left, no route.
  const route = (input.route ?? []).filter(onGlobe).map(([lat, lng]) => [lng, lat]);
  const data = scriptJson({
    styleUrl: input.styleUrl,
    markers: input.markers.map((m) => ({ lngLat: [m.lng, m.lat], label: m.label, description: m.description ?? '', value: pinValue(m.value) ?? '' })),
    interactive: input.interactive !== false,
    route: route.length > 1 ? route : [],
    zoom: input.zoom ?? null,
    routeColor: input.routeColor,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>${input.css.replace(/<\/style/gi, '<\\/style')}
html,body,#map{margin:0;height:100%;background:${input.background}}
.kx-pop{font:14px -apple-system,system-ui,sans-serif}.kx-pop p{margin:4px 0 0;opacity:.7}
.kx-pin{display:flex;flex-direction:column;align-items:center;font:600 12px -apple-system,system-ui,sans-serif}
.kx-bubble{background:${input.pin.surface};color:${input.pin.ink};border:1px solid ${input.pin.border};border-radius:999px;padding:3px 9px;font-variant-numeric:tabular-nums;box-shadow:0 2px 6px ${input.pin.shadow}}
.kx-dot{width:14px;height:14px;border-radius:999px;background:${input.pin.ink};border:2px solid ${input.pin.surface};box-shadow:0 2px 6px ${input.pin.shadow}}
.kx-name{margin-top:3px;max-width:140px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:${input.pin.ink};font-weight:500;text-shadow:0 0 3px ${input.pin.surface},0 0 3px ${input.pin.surface}}</style></head>
<body><div id="map"></div>
<script>${input.script.replace(/<\/script/gi, '<\\/script')}</script>
<script>
(function(){
  var d = ${data};
  // The camera is set at construction, so the page never shows the whole world first.
  var points = d.markers.map(function (m) { return m.lngLat; }).concat(d.route);
  var camera = { center: points[0] || [0, 0], zoom: d.zoom || (points.length ? 14 : 1) };
  if (points.length > 1) {
    var bounds = new maplibregl.LngLatBounds();
    points.forEach(function (p) { bounds.extend(p); });
    camera = { bounds: bounds, fitBoundsOptions: { padding: 48, maxZoom: d.zoom || 16 } };
  }
  camera.container = 'map';
  camera.style = d.styleUrl;
  camera.attributionControl = { compact: true };
  camera.interactive = d.interactive;
  var map = new maplibregl.Map(camera);
  if (d.interactive) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  d.markers.forEach(function (m) {
    // Web's MapPin: the figure in a bubble (or a dot without one), the place name under it.
    var pin = document.createElement('div');
    pin.className = 'kx-pin';
    var mark = document.createElement('div');
    mark.className = m.value ? 'kx-bubble' : 'kx-dot';
    mark.textContent = m.value;
    pin.appendChild(mark);
    var name = document.createElement('div');
    name.className = 'kx-name';
    name.textContent = m.label;
    pin.appendChild(name);
    var marker = new maplibregl.Marker({ element: pin, anchor: 'top' }).setLngLat(m.lngLat);
    if (d.interactive) {
      var pop = document.createElement('div');
      pop.className = 'kx-pop';
      var title = document.createElement('strong');
      title.textContent = m.label;
      pop.appendChild(title);
      if (m.description) { var p = document.createElement('p'); p.textContent = m.description; pop.appendChild(p); }
      marker.setPopup(new maplibregl.Popup({ offset: 24 }).setDOMContent(pop));
    }
    marker.addTo(map);
  });
  map.on('load', function () {
    if (d.route.length < 2) return;
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d.route } } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-width': 3, 'line-color': d.routeColor } });
  });
})();
</script></body></html>`;
}
