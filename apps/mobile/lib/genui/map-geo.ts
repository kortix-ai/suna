/** Places for the generative UI Map: range checks and the links a place opens. Pure; web's `map-geo.ts`. */

/** One Marker, every field the catalog defines. */
export type MapPlace = {
  id: string;
  lat: number;
  lng: number;
  label: string;
  description?: string;
  value?: string;
  href?: string;
  image?: string;
  phone?: string;
  kind?: string;
};

export type PlaceAction = 'directions' | 'website' | 'call';

export const inRange = (lat: unknown, lng: unknown): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat as number) <= 90 && Math.abs(lng as number) <= 180;

/** Directions to the place from wherever the reader is, in Google Maps (the app on a phone, the site elsewhere). */
export const directionsLink = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/** A tel: link from a written phone number: digits and a leading + only, or null when nothing dials. */
export function telLink(phone: string | undefined): string | null {
  const digits = (phone ?? '').replace(/(?!^\+)[^\d]/g, '');
  return digits.replace('+', '').length >= 5 ? `tel:${digits}` : null;
}
