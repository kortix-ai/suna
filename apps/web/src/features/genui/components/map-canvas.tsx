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
import { useState } from 'react';

import { MarkdownLink } from '@/components/markdown/unified-markdown';
import { MapControls, Map as MapLibreMap, MapMarker, MapRoute, MarkerContent, MarkerPopup, type MapStyleOption } from '@/components/ui/map';
import { useTranslations } from '@/i18n/use-translations';

import { mapBounds, osmLink, type MapPlace } from './map-geo';

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

export default function GenuiMapCanvas({
  places,
  route,
  zoom,
  styles,
}: {
  places: MapPlace[];
  route: [number, number][] | undefined;
  zoom: number | undefined;
  styles: { light: MapStyleOption; dark: MapStyleOption };
}) {
  const t = useTranslations('genui');
  const { resolvedTheme } = useTheme();
  // No document in a server render (the share page): the client computes it when it hydrates.
  const [routeColor] = useState(() => (route && typeof document !== 'undefined' ? routeRgb() : null));

  // Frame every place and every route point. A zoom from the model keeps that frame's center.
  // MapLibre reads the view once, at creation; `map.tsx` mounts this only once the block settles.
  const frame = [...places, ...(route ?? []).map(([lng, lat]) => ({ lat, lng }))];
  const [[west, south], [east, north]] = mapBounds(frame);
  const view =
    zoom !== undefined
      ? { center: [(west + east) / 2, (south + north) / 2] as [number, number], zoom }
      : frame.length === 1
        ? { center: [west, south] as [number, number], zoom: 14 }
        : { bounds: mapBounds(frame), fitBoundsOptions: { padding: 40, maxZoom: 15 } };

  return (
    <MapLibreMap
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      styles={styles}
      {...view}
      {...canvasOptions(t)}
    >
      <MapControls labels={{ zoomIn: t('zoomIn'), zoomOut: t('zoomOut') }} />
      {route && routeColor ? <MapRoute coordinates={route} color={routeColor} /> : null}
      {places.map((place) => (
        <MapMarker key={place.id} longitude={place.lng} latitude={place.lat} label={place.label}>
          <MarkerContent />
          <MarkerPopup>
            <p className="text-sm font-medium text-balance">
              <MarkdownLink href={osmLink(place.lat, place.lng)}>{place.label}</MarkdownLink>
            </p>
            {place.description ? <p className="text-muted-foreground mt-1 text-xs text-pretty">{place.description}</p> : null}
          </MarkerPopup>
        </MapMarker>
      ))}
    </MapLibreMap>
  );
}
