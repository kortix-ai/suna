/** The fullscreen map document for react-native-webview. Pure: unit-tested under Bun. */

import { escapeForInlineScript } from '@/lib/utils/html-embed';

export interface MapDocumentInput {
  /** maplibre-gl.js source, loaded from the bundled asset. */
  script: string;
  /** maplibre-gl.css source. */
  css: string;
  styleUrl: string;
  markers: { lat: number; lng: number; label: string; description?: string }[];
  /** [lat, lng] pairs, as the catalog stores them. */
  route?: [number, number][];
  zoom?: number;
  /** Page background and route color: theme tokens through `withAlpha`, never hex (mobile AGENTS.md). */
  background: string;
  routeColor: string;
}

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
    markers: input.markers.map((m) => ({ lngLat: [m.lng, m.lat], label: m.label, description: m.description ?? '' })),
    route: route.length > 1 ? route : [],
    zoom: input.zoom ?? null,
    routeColor: input.routeColor,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>${input.css.replace(/<\/style/gi, '<\\/style')}
html,body,#map{margin:0;height:100%;background:${input.background}}
.kx-pop{font:14px -apple-system,system-ui,sans-serif}.kx-pop p{margin:4px 0 0;opacity:.7}</style></head>
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
  var map = new maplibregl.Map(camera);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  d.markers.forEach(function (m) {
    var pop = document.createElement('div');
    pop.className = 'kx-pop';
    var title = document.createElement('strong');
    title.textContent = m.label;
    pop.appendChild(title);
    if (m.description) { var p = document.createElement('p'); p.textContent = m.description; pop.appendChild(p); }
    new maplibregl.Marker().setLngLat(m.lngLat).setPopup(new maplibregl.Popup({ offset: 24 }).setDOMContent(pop)).addTo(map);
  });
  map.on('load', function () {
    if (d.route.length < 2) return;
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d.route } } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-width': 3, 'line-color': d.routeColor } });
  });
})();
</script></body></html>`;
}
