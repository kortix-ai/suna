'use client';

/**
 * The generative UI Map. `index.tsx` loads this module through `lazy()`.
 *
 * The figure is a card: the mapcn map (MapLibre on the `mapStyles()` basemap),
 * each pin a bubble with its value and its name under it; a pin's popup is
 * the place card (photo, name, value · kind, Directions, Website, Call). With the map switched off (`NEXT_PUBLIC_GENUI_MAP_STYLE_URL=off`)
 * the card is one row per place with Directions instead.
 *
 * mapcn's default basemap (CARTO) needs an enterprise license for commercial use,
 * so the canvas draws only on a style we configure (OpenFreeMap by default).
 * With a style, `map-canvas.tsx` (MapLibre GL, ~600 KB) loads on demand, so the
 * place list never downloads it.
 *
 * HEIGHT: the map well is `MAP_BOX` (280px), the box the pending block reserves.
 *
 * STREAMING: with a style, the map holds the pending box until its block settles
 * (its fence closes). The prompt writes `Map([a, b])` before its markers, so a
 * streamed map has 0, then 1, then n markers: holding the box keeps the height
 * still, and MapLibre is created once, framing every marker and the route.
 */

// eslint-disable-next-line no-restricted-imports -- screen-reader text for the figure; this module is reached only through lazy()
import { genuiA11yText } from '@kortix/sdk/genui';
import { lazy, Suspense } from 'react';

import { Button } from '../../../../components/ui/button';
import Loading from '../../../../components/ui/loading';
import { useTranslations } from '../../../../i18n';
import { cn } from '../../../../lib/utils';

import type { GenuiComponentProps, GenuiNode } from '../sdk';
import { kids } from './layout';
import { directionsLink, inRange, mapStyles, routeCoordinates, type MapPlace } from './map-geo';
import { GenuiPending, MAP_BOX } from './pending';

const MapCanvas = lazy(() => import('./map-canvas'));

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
            value: m.props.value ? String(m.props.value) : undefined,
            href: m.props.href ? String(m.props.href) : undefined,
            image: m.props.image ? String(m.props.image) : undefined,
            phone: m.props.phone ? String(m.props.phone) : undefined,
            kind: m.props.kind ? String(m.props.kind) : undefined,
          },
        ]
      : [],
  );
}

function PlaceRow({ place }: { place: MapPlace }) {
  const t = useTranslations('genui');
  return (
    <li className="flex items-center justify-between gap-4 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium text-balance">{place.label}</span>
        {place.description ? <span className="text-muted-foreground text-sm text-pretty">{place.description}</span> : null}
      </div>
      <Button size="sm" className="shrink-0" asChild>
        <a href={directionsLink(place.lat, place.lng)} target="_blank" rel="noopener noreferrer">
          {t('directions')}
        </a>
      </Button>
    </li>
  );
}

/** Paper Map 16: a card. The map well sits on top when tiles are configured; each place is a row under it. */
function PlaceList({ places }: { places: MapPlace[] }) {
  return (
    <ul className="divide-border flex flex-col divide-y">
      {places.map((place) => (
        <PlaceRow key={place.id} place={place} />
      ))}
    </ul>
  );
}

export function GenuiMapView({
  node,
  props,
  streaming,
  styleUrl,
  styleUrlDark,
}: GenuiComponentProps & { styleUrl: string | undefined; styleUrlDark?: string }) {
  if (styleUrl && streaming) return <>{GenuiPending(node)}</>;
  const all = places(kids(props.markers));
  const label = genuiA11yText(node) ?? undefined;

  const canvas = Boolean(styleUrl) && all.length > 0;
  return (
    <figure className="flex flex-col gap-2" aria-label={label}>
      <div className={cn('border-border rounded-xl border', canvas && 'p-0 overflow-hidden ')}>
        {canvas ? (
          // The well keeps MAP_BOX's 280px, the box the pending block reserves.
          <div className={cn(MAP_BOX, 'bg-card rounded-md border-0')}>
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
                styles={{ light: styleUrl!, dark: styleUrlDark || styleUrl! }}
                // A basemap that fails to load shows the places as rows, as with the map switched off.
                fallback={<PlaceList places={all} />}
              />
            </Suspense>
          </div>
        ) : (
          // The map switched off: the places as rows, each with Directions. With a map, the pins carry their
          // names and values and a pin's popup is the place card, so no list sits under it.
          <PlaceList places={all} />
        )}
      </div>
    </figure>
  );
}

export default function GenuiMap(props: GenuiComponentProps) {
  return (
    <GenuiMapView
      {...props}
      styleUrl={mapStyles()?.light}
      styleUrlDark={mapStyles()?.dark}
    />
  );
}
