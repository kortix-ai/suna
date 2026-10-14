'use client';

/**
 * The MapLibre canvas of the generative UI Map. `map.tsx` loads it through
 * `lazy()` only when a tile style is configured: this module is the one that
 * reaches `maplibre-gl`.
 *
 * The map sits inside a scrolling chat. The wheel never zooms it
 * (`scrollZoom` off, so MapLibre's desktop hint never shows); the zoom buttons
 * do. On touch, cooperative gestures let one finger scroll the chat while two
 * fingers pan and pinch. Rotation and pitch are off: there is no compass to
 * undo them.
 */

import type { MapOptions } from 'maplibre-gl';
import { useTheme } from 'next-themes';
import { useState, type ReactNode } from 'react';

import { MarkdownImage } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { MapControls, Map as MapLibreMap, MapMarker, MapRoute, MarkerContent, MarkerPopup, useMap, type MapStyleOption } from '@/components/ui/map';
import { useTranslations } from '@/i18n/use-translations';

import { directionsLink, mapBounds, pinValue, telLink, type MapPlace } from './map-geo';

/** Gesture and UI-string options for the chat map. `t` reads the `genui` namespace. */
export function canvasOptions(t: (key: 'map' | 'mapTwoFingers') => string) {
  return {
    scrollZoom: false,
    cooperativeGestures: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    locale: { 'Map.Title': t('map'), 'CooperativeGesturesHandler.MobileHelpText': t('mapTwoFingers') },
  } satisfies Partial<MapOptions>;
}

/**
 * The first CSS color in `values` as `rgb()`. A 2D canvas ignores a fillStyle
 * it cannot parse, so a value that leaves the pixel transparent did not apply:
 * try the next. With no canvas, or no value that applies, return `gray`, a
 * mid grey that reads on light and dark basemaps.
 */
export function paintRgb(
  context: Pick<CanvasRenderingContext2D, 'clearRect' | 'fillStyle' | 'fillRect' | 'getImageData'> | null,
  values: string[],
): string {
  const fallback = 'gray';
  if (!context) return fallback;
  for (const value of values) {
    if (!value) continue;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = 'transparent';
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (a) return `rgb(${r}, ${g}, ${b})`;
  }
  return fallback;
}

/**
 * MapLibre paints the route itself and cannot parse `var()` or `oklch()`. Draw
 * the token on a 1px canvas and read the sRGB value back. `--chart-3` is the
 * first series color of the charts and is the same in both themes; `--foreground`
 * (ink) is the fallback.
 */
function routeRgb(): string {
  const root = getComputedStyle(document.documentElement);
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return paintRgb(context, ['--chart-3', '--foreground'].map((token) => root.getPropertyValue(token).trim()));
}

/** px beside the outermost pins for a name centred under its pin: half the longest name (about 6.5px a character at 12px), capped at the name's 144px max width. */
export function labelRoom(places: Pick<MapPlace, 'label'>[]): number {
  const longest = Math.max(0, ...places.map((place) => place.label.length));
  return Math.max(40, Math.min(72, Math.round((longest * 6.5) / 2) + 16));
}

/**
 * A pin is a bubble with the place's value in its centre (the figure the user asked about: a rating, a price),
 * or a dot when there is none, and the place's name under it. A click opens the place card above the pin and
 * glides the map so the pin sits near the bottom edge: the card then has the map's height and is never cut
 * off. Reduced motion jumps instead.
 */
function MapPin({ place }: { place: MapPlace }) {
  const { map } = useMap();
  // The pin shows only a figure (a price, a rating): a value with no digit, such as "Luxury", stays in the card.
  const figure = pinValue(place.value);
  const raise = () => {
    if (!map) return;
    const offset: [number, number] = [0, map.getContainer().clientHeight / 2 - 56];
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.easeTo({ center: [place.lng, place.lat], offset, duration: still ? 0 : 250 });
  };
  return (
    <MarkerContent>
      {/* One button: the bubble and the name. Its click also reaches MapLibre's marker, which opens the card. */}
      <button type="button" onClick={raise} aria-label={figure ? `${place.label}, ${figure}` : place.label} className="flex flex-col items-center">
        {figure ? (
          <span className="bg-background text-foreground border-border rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap tabular-nums shadow-md">
            {figure}
          </span>
        ) : (
          <span className="bg-foreground border-background block size-3.5 rounded-full border-2 shadow-md" />
        )}
        <span className="bg-background/80 text-foreground absolute top-full mt-1 max-w-36 truncate rounded-sm px-1 text-xs font-medium whitespace-nowrap">
          {place.label}
        </span>
      </button>
    </MarkerContent>
  );
}

/**
 * The place card a pin opens (Apple Maps' layout): the photo, the name, the value and what it is, the address,
 * then Directions and, when the agent gave them, Website and Call.
 */
function PlaceCard({ place }: { place: MapPlace }) {
  const t = useTranslations('genui');
  const tel = telLink(place.phone);
  const facts = [place.value, place.kind].filter(Boolean).join(' · ');
  const action = (href: string, label: string, primary = false) => (
    <Button size="sm" variant={primary ? 'default' : 'outline'} className="flex-1 rounded-full" asChild>
      <a href={href} target={href.startsWith('tel:') ? undefined : '_blank'} rel="noopener noreferrer">
        {label}
      </a>
    </Button>
  );
  return (
    <MarkerPopup anchor="bottom" focusAfterOpen={false} className="w-80 max-w-none p-3">
      <div className="flex gap-3">
        {place.image ? (
          <div className="bg-muted size-16 shrink-0 overflow-hidden rounded-lg [&>span]:size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-cover [&_img]:outline-0">
            <MarkdownImage src={place.image} alt="" flush compact />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-foreground text-base leading-tight font-medium text-balance">{place.label}</p>
          {facts ? <p className="text-foreground text-sm tabular-nums">{facts}</p> : null}
          {place.description ? <p className="text-muted-foreground text-xs text-pretty">{place.description}</p> : null}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        {action(directionsLink(place.lat, place.lng), t('directions'), true)}
        {place.href ? action(place.href, t('website')) : null}
        {tel ? action(tel, t('call')) : null}
      </div>
    </MarkerPopup>
  );
}

export default function GenuiMapCanvas({
  places,
  route,
  zoom,
  styles,
  fallback,
}: {
  places: MapPlace[];
  route: [number, number][] | undefined;
  zoom: number | undefined;
  styles: { light: MapStyleOption; dark: MapStyleOption };
  /** Shown in the well when the basemap style fails to load. */
  fallback?: ReactNode;
}) {
  const t = useTranslations('genui');
  const { resolvedTheme } = useTheme();
  // No document in a server render (the share page): the client computes it when it hydrates.
  const [routeColor] = useState(() => (route && typeof document !== 'undefined' ? routeRgb() : null));

  // Frame every place and every route point.
  // MapLibre reads the view once, at creation; `map.tsx` mounts this only once the block settles.
  const frame = [...places, ...(route ?? []).map(([lng, lat]) => ({ lat, lng }))];
  const [[west, south], [east, north]] = mapBounds(frame);
  // One place: center on it at the model's zoom. Several: fit every pin with room for its name (centred under
  // the pin, so half a name each side, and a line below), and treat the model's zoom as the closest the map
  // may go, so no pin or name lands outside the frame.
  const view =
    frame.length === 1
      ? { center: [west, south] as [number, number], zoom: zoom ?? 14 }
      : {
          bounds: mapBounds(frame),
          fitBoundsOptions: { padding: { top: 40, bottom: 56, left: labelRoom(places), right: labelRoom(places) }, maxZoom: zoom ?? 15 },
        };

  return (
    <MapLibreMap
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      styles={styles}
      fallback={fallback}
      {...view}
      {...canvasOptions(t)}
    >
      <MapControls labels={{ zoomIn: t('zoomIn'), zoomOut: t('zoomOut') }} />
      {route && routeColor ? <MapRoute coordinates={route} color={routeColor} /> : null}
      {places.map((place) => (
        <MapMarker key={place.id} longitude={place.lng} latitude={place.lat} label={place.label}>
          {/* The dot, and beside it the place's name with its value (a rating, a price): every pin says
              what it is, so the map reads without a list under it. */}
          <MapPin place={place} />
          <PlaceCard place={place} />
        </MapMarker>
      ))}
    </MapLibreMap>
  );
}
