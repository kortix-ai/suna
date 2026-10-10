/** Coordinates for the generative UI Map: range checks, bounds, routes, links. No React, no MapLibre. */

export type LatLng = { lat: number; lng: number };

export type MapPlace = LatLng & { id: string; label: string; description?: string };

export const inRange = (lat: unknown, lng: unknown): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180;

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
