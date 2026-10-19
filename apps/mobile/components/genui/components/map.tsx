import { useColorScheme } from 'nativewind';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';

import { MapSheet, MapWebView, type MapSheetData } from '../map/map-sheet';
import { kids } from './layout';

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';

/**
 * The basemap, as web's `mapStyles()`: OpenFreeMap by default (free for commercial use, no key, no
 * request limit; its style carries the OpenMapTiles and OpenStreetMap attribution). The env var
 * overrides it, for both themes; `off` draws no map, only the place rows.
 */
export function mapStyleUrl(dark: boolean, env: string | undefined = process.env.EXPO_PUBLIC_GENUI_MAP_STYLE_URL): string | null {
  if (env === 'off') return null;
  if (env) return env;
  return `${OPENFREEMAP}/${dark ? 'dark' : 'positron'}`;
}

type Place = { id: string; lat: number; lng: number; label: string; description?: string; value?: string };

/** The inline map's height: a still picture of the places, as on web; a tap opens it full screen. */
const MAP_HEIGHT = 240;

/**
 * Web parity: the map itself in the transcript, with web's pins (the figure in a bubble, the name under
 * it) and no rows or buttons. Inline it is a still picture, so it never fights the transcript scroll; a
 * tap opens the interactive map full screen. With the map off (`EXPO_PUBLIC_GENUI_MAP_STYLE_URL=off`)
 * the places are a plain list.
 */
export function GenuiMap({ props, styleUrl }: GenuiComponentProps & { styleUrl?: string }) {
  const { t } = useTranslation();
  const { colorScheme } = useColorScheme();
  const [open, setOpen] = useState(false);
  const style = mapStyleUrl(colorScheme === 'dark', styleUrl);
  const markers = useMemo<Place[]>(
    () =>
      kids(props.markers).map((m) => ({
        id: m.id,
        lat: Number(m.props.lat),
        lng: Number(m.props.lng),
        label: String(m.props.label),
        description: m.props.description ? String(m.props.description) : undefined,
        value: m.props.value ? String(m.props.value) : undefined,
      })),
    [props.markers],
  );
  const data = useMemo<MapSheetData>(
    () => ({
      styleUrl: style ?? '',
      markers,
      route: props.route as [number, number][] | undefined,
      zoom: props.zoom as number | undefined,
    }),
    [style, markers, props.route, props.zoom],
  );
  const title = markers.length === 1 ? markers[0]!.label : t('genui.map', 'Map');

  if (!style) {
    return (
      <View className="rounded-2xl bg-card">
        {markers.map((m, i) => (
          <Fragment key={m.id}>
            {i > 0 ? <Separator /> : null}
            <View className="gap-0.5 px-4 py-3">
              <Text className="font-medium">{m.label}</Text>
              {m.description ? <Text variant="muted">{m.description}</Text> : null}
            </View>
          </Fragment>
        ))}
      </View>
    );
  }
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
          <MapWebView data={data} interactive={false} />
        </View>
      </Pressable>
      {open ? <MapSheet title={title} data={data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
