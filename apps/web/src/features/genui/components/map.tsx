'use client';

/**
 * The generative UI Map. `index.tsx` loads this module through `lazy()`.
 *
 * Without `NEXT_PUBLIC_GENUI_MAP_STYLE_URL` it is a place list: each place
 * links to OpenStreetMap. mapcn's default basemap (CARTO) needs an enterprise
 * license for commercial use, so the canvas draws only on a style we configure.
 * With a style, `map-canvas.tsx` (MapLibre GL, ~600 KB) loads on demand, so the
 * place list never downloads it.
 *
 * HEIGHT: the canvas figure is `MAP_FIGURE_HEIGHT` (arithmetic in `pending.tsx`),
 * the same box the pending block reserves. The place list reserves nothing.
 */

// eslint-disable-next-line no-restricted-imports -- screen-reader text for the figure; this module is reached only through lazy()
import { genuiA11yText } from '@kortix/sdk/genui';
import { MapPinIcon } from '@phosphor-icons/react';
import { lazy, Suspense } from 'react';

import { MarkdownLink } from '@/components/markdown/unified-markdown';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps, GenuiNode } from '../sdk';
import { kids } from './layout';
import { MAP_BOX, MAP_FIGURE_HEIGHT } from './pending';

const MapCanvas = lazy(() => import('./map-canvas'));

export type LatLng = { lat: number; lng: number };

const inRange = (lat: unknown, lng: unknown): boolean =>
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

export type MapPlace = LatLng & { id: string; label: string; description?: string };

function places(markers: GenuiNode[]): MapPlace[] {
  return markers.flatMap((m) =>
    inRange(m.props.lat, m.props.lng)
      ? [
          {
            id: m.id,
            lat: m.props.lat as number,
            lng: m.props.lng as number,
            label: String(m.props.label),
            description: m.props.description ? String(m.props.description) : undefined,
          },
        ]
      : [],
  );
}

function PlaceList({ places }: { places: MapPlace[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {places.map((place) => (
        <li key={place.id} className="flex gap-2">
          <MapPinIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <MarkdownLink href={osmLink(place.lat, place.lng)}>{place.label}</MarkdownLink>
            {place.description ? <p className="text-muted-foreground text-pretty">{place.description}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function GenuiMapView({
  node,
  props,
  styleUrl,
  styleUrlDark,
}: GenuiComponentProps & { styleUrl: string | undefined; styleUrlDark?: string }) {
  const t = useTranslations('genui');
  const all = places(kids(props.markers));
  const caption = <figcaption className="text-muted-foreground text-xs text-pretty">{t('source', { source: String(props.source) })}</figcaption>;
  const label = genuiA11yText(node) ?? undefined;

  if (!styleUrl || all.length === 0) {
    return (
      <figure className="flex flex-col gap-2" aria-label={label}>
        <PlaceList places={all} />
        {caption}
      </figure>
    );
  }

  return (
    <figure className={cn(MAP_FIGURE_HEIGHT, 'flex flex-col gap-2')} aria-label={label}>
      <div className={MAP_BOX}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Loading />
            </div>
          }
        >
          <MapCanvas
            places={all}
            route={routeCoordinates(props.route)}
            zoom={typeof props.zoom === 'number' ? props.zoom : undefined}
            styles={{ light: styleUrl, dark: styleUrlDark || styleUrl }}
          />
        </Suspense>
      </div>
      {caption}
    </figure>
  );
}

export default function GenuiMap(props: GenuiComponentProps) {
  return (
    <GenuiMapView
      {...props}
      styleUrl={process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL || undefined}
      styleUrlDark={process.env.NEXT_PUBLIC_GENUI_MAP_STYLE_URL_DARK || undefined}
    />
  );
}
