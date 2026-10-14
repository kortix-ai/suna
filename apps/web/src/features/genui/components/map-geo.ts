/** Coordinates for the generative UI Map: range checks, bounds, routes, links. No React, no MapLibre. */

export type LatLng = { lat: number; lng: number };

export type MapPlace = LatLng & {
  id: string;
  label: string;
  description?: string;
  value?: string;
  href?: string;
  image?: string;
  phone?: string;
  kind?: string;
};

export const inRange = (lat: unknown, lng: unknown): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180;

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';

/**
 * The basemap styles. OpenFreeMap by default: free for commercial use, no key, no request limit, and its
 * style carries the OpenMapTiles and OpenStreetMap attribution MapLibre renders. mapcn's own default
 * (CARTO) needs an enterprise license. `NEXT_PUBLIC_GENUI_MAP_STYLE_URL` overrides it; `off` draws no
 * map, only the place rows (the kill switch if the tile host is down).
 */
export function mapStyles(): { light: string; dark: string } | null {
  const url = process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL;
  if (url === 'off') return null;
  if (url) return { light: url, dark: process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK || url };
  return { light: `${OPENFREEMAP}/positron`, dark: `${OPENFREEMAP}/dark` };
}

/**
 * A marker value worth a pin: a figure (★ 4.7, ₹24,000, 1.2M), so it has a digit. A word the model put there
 * (a category such as "Luxury") is not a value: the pin stays a dot and the card skips it.
 */
export const pinValue = (value: string | undefined): string | undefined => (value && /\d/.test(value) ? value : undefined);

/** Directions to the place from wherever the reader is, in Google Maps (the app on a phone, the site elsewhere). */
export const directionsLink = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/** A tel: link from a written phone number: digits and a leading + only, or null when nothing dials. */
export function telLink(phone: string | undefined): string | null {
  const digits = (phone ?? '').replace(/(?!^\+)[^\d]/g, '');
  return digits.replace('+', '').length >= 5 ? `tel:${digits}` : null;
}

export const osmLink = (lat: unknown, lng: unknown) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

/** South-west and north-east corners as [lng, lat], the order MapLibre takes. */
export function mapBounds(points: LatLng[]): [[number, number], [number, number]] {
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

/**
 * `Map.route` is [lat, lng] pairs; MapLibre takes [lng, lat]. The SDK checks each
 * Marker's range but not route points, and a model that writes GeoJSON order puts
 * a longitude in the latitude slot: MapLibre throws `Invalid LngLat` on it. Drop
 * every point out of range; a route needs two points that remain.
 */
export function routeCoordinates(route: unknown): [number, number][] | undefined {
  if (!Array.isArray(route)) return undefined;
  const points = route.flatMap((point): [number, number][] =>
    Array.isArray(point) && inRange(point[0], point[1]) ? [[point[1] as number, point[0] as number]] : [],
  );
  return points.length >= 2 ? points : undefined;
}
