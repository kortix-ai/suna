'use client';

/**
 * The MapLibre canvas of the generative UI Map. `map.tsx` loads it through
 * `lazy()` only when a tile style is configured: this module is the one that
 * reaches `maplibre-gl`.
 *
 * In a chat the page scrolls, so the wheel never zooms the map (`scrollZoom`
 * off); the zoom buttons and pinch do. Rotation and pitch are off: there is no
 * compass to undo them.
 */

import { useTheme } from 'next-themes';
import { useState } from 'react';

import { MarkdownLink } from '@/components/markdown/unified-markdown';
import { MapControls, Map as MapLibreMap, MapMarker, MapRoute, MarkerContent, MarkerPopup, type MapStyleOption } from '@/components/ui/map';
import { useTranslations } from '@/i18n/use-translations';

import { mapBounds, osmLink, type MapPlace } from './map';

/**
 * MapLibre paints the route itself and cannot parse `var()` or `oklch()`. Draw
 * the token on a 1px canvas and read the sRGB value back. `--chart-3` is the
 * first series color of the charts and is the same in both themes.
 */
function tokenRgb(token: string): string | null {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
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
  const [routeColor] = useState(() => (route ? tokenRgb('--chart-3') : null));

  // Frame every place and every route point. A zoom from the model keeps that frame's center.
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
      scrollZoom={false}
      dragRotate={false}
      pitchWithRotate={false}
      touchPitch={false}
      locale={{ 'Map.Title': t('map') }}
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
