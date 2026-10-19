/** The map document for react-native-webview, inline in the transcript or full screen. Pure: unit-tested under Bun. */

import { safeUrl } from '@kortix/sdk/genui';

import { telLink, type MapPlace } from '@/lib/genui/map-geo';
import { escapeForInlineScript } from '@/lib/utils/html-embed';

export interface MapDocumentInput {
  /** maplibre-gl.js source, loaded from the bundled asset. */
  script: string;
  /** maplibre-gl.css source. */
  css: string;
  styleUrl: string;
  /**
   * `value` is the figure in the pin (a rating, a price); a pin shows it only when it holds a digit, as on web.
   * The popup is the place card: photo, name, `value · kind`, description, Directions / Website / Call.
   */
  markers: Omit<MapPlace, 'id'>[];
  /** [lat, lng] pairs, as the catalog stores them. */
  route?: [number, number][];
  zoom?: number;
  /** Page background and route color: theme tokens through `withAlpha`, never hex (mobile AGENTS.md). */
  background: string;
  routeColor: string;
  /** Pin colors (web's MapPin): the surface bubble, its ink, and its hairline; `muted` fills a secondary popup button. */
  pin: { surface: string; ink: string; border: string; shadow: string; muted: string };
  /** The popup's button labels, translated. */
  labels: { directions: string; website: string; call: string };
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
    // No link reaches the page: a popup button posts { index, action } and native opens the place's own link.
    markers: input.markers.map((m) => ({
      lngLat: [m.lng, m.lat],
      label: m.label,
      description: m.description ?? '',
      value: pinValue(m.value) ?? '',
      facts: [m.value, m.kind].filter(Boolean).join(' · '),
      image: safeUrl(m.image) ?? '',
      website: Boolean(safeUrl(m.href)),
      call: Boolean(telLink(m.phone)),
    })),
    labels: input.labels,
    interactive: input.interactive !== false,
    route: route.length > 1 ? route : [],
    zoom: input.zoom ?? null,
    routeColor: input.routeColor,
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>${input.css.replace(/<\/style/gi, '<\\/style')}
html,body,#map{margin:0;height:100%;background:${input.background}}
.maplibregl-popup-content{background:${input.pin.surface};color:${input.pin.ink};border-radius:12px;padding:12px;box-shadow:0 4px 16px ${input.pin.shadow}}
.maplibregl-popup-anchor-bottom .maplibregl-popup-tip{border-top-color:${input.pin.surface}}.maplibregl-popup-anchor-top .maplibregl-popup-tip{border-bottom-color:${input.pin.surface}}
.maplibregl-popup-close-button{color:${input.pin.ink};font-size:18px;padding:0 6px}
.kx-pop{font:14px -apple-system,system-ui,sans-serif;width:248px}.kx-head{display:flex;gap:12px}.kx-body{flex:1;min-width:0;padding-right:12px}
.kx-photo{width:64px;height:64px;flex-shrink:0;border-radius:8px;object-fit:cover;background:${input.pin.muted}}
.kx-pop strong{display:block;font-size:16px;line-height:1.25;font-weight:500}.kx-facts{margin-top:2px;font-variant-numeric:tabular-nums}.kx-desc{margin:2px 0 0;font-size:12px;opacity:.7}
.kx-acts{display:flex;gap:8px;margin-top:12px}.kx-act{flex:1;height:32px;border:0;border-radius:999px;font:500 13px -apple-system,system-ui,sans-serif;background:${input.pin.muted};color:${input.pin.ink}}
.kx-primary{background:${input.pin.ink};color:${input.pin.surface}}
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
  function post(index, action) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'place', index: index, action: action }));
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  // Web's PlaceCard: photo, name, value · kind, description; Directions, then Website and Call when the place has them.
  function card(m, index) {
    var pop = el('div', 'kx-pop');
    var head = el('div', 'kx-head');
    if (m.image) {
      var photo = el('img', 'kx-photo');
      photo.alt = '';
      photo.src = m.image;
      photo.onerror = function () { photo.style.display = 'none'; };
      head.appendChild(photo);
    }
    var body = el('div', 'kx-body');
    body.appendChild(el('strong', '', m.label));
    if (m.facts) body.appendChild(el('div', 'kx-facts', m.facts));
    if (m.description) body.appendChild(el('p', 'kx-desc', m.description));
    head.appendChild(body);
    pop.appendChild(head);
    var acts = el('div', 'kx-acts');
    function act(action, label, primary) {
      var button = el('button', primary ? 'kx-act kx-primary' : 'kx-act', label);
      button.onclick = function () { post(index, action); };
      acts.appendChild(button);
    }
    act('directions', d.labels.directions, true);
    if (m.website) act('website', d.labels.website);
    if (m.call) act('call', d.labels.call);
    pop.appendChild(acts);
    return pop;
  }
  d.markers.forEach(function (m, index) {
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
    if (d.interactive) marker.setPopup(new maplibregl.Popup({ offset: 24, maxWidth: 'none' }).setDOMContent(card(m, index)));
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
