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
import { inRange, osmLink, routeCoordinates, type MapPlace } from './map-geo';
import { MAP_BOX, MAP_FIGURE_HEIGHT } from './pending';

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
  const source = t('source', { source: String(props.source) });
  const label = genuiA11yText(node) ?? undefined;

  if (!styleUrl || all.length === 0) {
    return (
      <figure className="flex flex-col gap-2" aria-label={label}>
        <PlaceList places={all} />
        <figcaption className="text-muted-foreground text-xs text-pretty">{source}</figcaption>
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
      {/* One line, full text on hover: a wrapped caption would grow past MAP_FIGURE_HEIGHT. */}
      <figcaption className="text-muted-foreground truncate text-xs" title={source}>
        {source}
      </figcaption>
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
