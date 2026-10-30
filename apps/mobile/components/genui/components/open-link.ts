import { safeUrl } from '@kortix/sdk/genui';

import { directionsLink, telLink, type MapPlace, type PlaceAction } from '@/lib/genui/map-geo';
import { openExternalLink, openLink } from '@/lib/utils/open-link';

/** Opens a URL the SDK already validated; re-checks it, because this is the last stop before the OS. */
export function openGenuiLink(href: unknown): void {
  const url = safeUrl(href);
  if (url) openExternalLink(url);
}

/** Dials a written phone number: digits and a leading + only; nothing happens when it does not dial. */
export function openGenuiCall(phone: string | undefined): void {
  const tel = telLink(phone);
  if (tel) openLink(tel).catch(() => {});
}

/** A place's Directions, Website, or Call, from a place-list row or a map popup. */
export function openPlaceAction(place: Pick<MapPlace, 'lat' | 'lng' | 'href' | 'phone'>, action: PlaceAction): void {
  if (action === 'directions') openGenuiLink(directionsLink(place.lat, place.lng));
  else if (action === 'website') openGenuiLink(place.href);
  else openGenuiCall(place.phone);
}
