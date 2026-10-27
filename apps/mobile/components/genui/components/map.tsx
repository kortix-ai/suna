import { useColorScheme } from 'nativewind';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import type { GenuiNode } from '@kortix/sdk/genui';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { inRange, type MapPlace } from '@/lib/genui/map-geo';
import { mapStyleUrl } from '@/lib/genui/map-style';

import { MapSheet, MapWebView, type MapSheetData } from '../map/map-sheet';
import { GenuiPlaceList } from '../map/place-list';
import { kids } from './layout';
import { GenuiPending, MAP_HEIGHT } from './pending';

export { mapStyleUrl };

const text = (value: unknown) => (value ? String(value) : undefined);

/** Every Marker with coordinates on the globe, with every field the catalog defines (web `map.tsx` `places`). */
function places(markers: GenuiNode[]): MapPlace[] {
  return markers.flatMap((m) => {
    if (!inRange(m.props.lat, m.props.lng)) return [];
    const place: MapPlace = { id: m.id, lat: m.props.lat as number, lng: m.props.lng as number, label: String(m.props.label) };
    for (const key of ['description', 'value', 'href', 'image', 'phone', 'kind'] as const) {
      const value = text(m.props[key]);
      if (value) place[key] = value;
    }
    return [place];
  });
}

/**
 * Web parity: the map itself in the transcript, with web's pins (the figure in a bubble, the name under
 * it) and no rows or buttons. Inline it is a still picture, so it never fights the transcript scroll; a
 * tap opens the interactive map full screen, where a pin's popup is the place card. With the map off
 * (`EXPO_PUBLIC_GENUI_MAP_STYLE_URL=off`), or when the basemap fails to draw, the places are rows with
 * Directions, Website, and Call.
 *
 * STREAMING: with a map, the block holds the pending box (`MAP_HEIGHT`) until its fence closes. The model
 * writes `Map([a, b])` before its markers, so a streamed map has 0, then 1, then n markers: waiting keeps
 * the height still and builds the WebView once, framing every marker and the route.
 */
export function GenuiMap({ node, props, streaming, styleUrl }: GenuiComponentProps & { styleUrl?: string }) {
  const { colorScheme } = useColorScheme();
  const style = mapStyleUrl(colorScheme === 'dark', styleUrl);
  if (style && streaming) return <>{GenuiPending(node)}</>;
  return <SettledMap markers={props.markers} route={props.route} zoom={props.zoom} style={style} />;
}

function SettledMap({ markers: nodes, route, zoom, style }: { markers: unknown; route: unknown; zoom: unknown; style: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const markers = useMemo(() => places(kids(nodes)), [nodes]);
  const data = useMemo<MapSheetData>(
    () => ({
      styleUrl: style ?? '',
      markers,
      route: Array.isArray(route) ? (route as [number, number][]) : undefined,
      zoom: typeof zoom === 'number' ? zoom : undefined,
    }),
    [style, markers, route, zoom],
  );
  const title = markers.length === 1 ? markers[0]!.label : t('genui.map', 'Map');

  // The map off, no place on the globe, or a basemap that failed: the places as rows (web's `fallback`).
  if (!style || !markers.length || failed) return <GenuiPlaceList places={markers} />;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t('genui.openMap', 'Open map')}: ${markers.map((m) => m.label).join(', ')}`}
        onPress={() => setOpen(true)}
        style={{ height: MAP_HEIGHT }}
        className="overflow-hidden rounded-2xl bg-card active:opacity-90"
      >
        {/* The still map takes no touches: the tap is the Pressable's, the scroll the transcript's. */}
        <View pointerEvents="none" className="flex-1">
          <MapWebView data={data} interactive={false} onFail={() => setFailed(true)} />
        </View>
      </Pressable>
      {open ? <MapSheet title={title} data={data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
