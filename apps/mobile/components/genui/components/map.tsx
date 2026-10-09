import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { GenuiComponentProps } from '@kortix/sdk/genui/react';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Text } from '@/components/ui/text';
import { MapPinIcon, MapTrifoldIcon } from '@/lib/icons';

import { MapSheet, type MapSheetData } from '../map/map-sheet';
import { kids } from './layout';
import { openGenuiLink } from './open-link';

const osmLink = (lat: unknown, lng: unknown) =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

/**
 * design.md §8: no embedded viewer in the transcript. Each place is the app's own list row and opens
 * OpenStreetMap; the interactive map opens full screen, and only when a tile style is configured.
 */
export function GenuiMap({
  props,
  styleUrl = process.env.EXPO_PUBLIC_GENUI_MAP_STYLE_URL,
}: GenuiComponentProps & { styleUrl?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const markers = kids(props.markers);
  const data = useMemo<MapSheetData>(
    () => ({
      styleUrl: styleUrl ?? '',
      markers: kids(props.markers).map((m) => ({
        lat: Number(m.props.lat),
        lng: Number(m.props.lng),
        label: String(m.props.label),
        description: m.props.description ? String(m.props.description) : undefined,
      })),
      route: props.route as [number, number][] | undefined,
      zoom: props.zoom as number | undefined,
    }),
    [styleUrl, props.markers, props.route, props.zoom],
  );

  return (
    <View className="gap-2">
      <SettingsGroup>
        {styleUrl ? (
          <SettingsRow icon={MapTrifoldIcon} label={t('genui.openMap', 'Open map')} onPress={() => setOpen(true)} dense />
        ) : null}
        {markers.map((m) => (
          <SettingsRow
            key={m.id}
            icon={MapPinIcon}
            label={String(m.props.label)}
            onPress={() => openGenuiLink(osmLink(m.props.lat, m.props.lng))}
            external
            dense
          />
        ))}
      </SettingsGroup>
      <Text variant="muted" className="px-4">
        {t('genui.source', { defaultValue: 'Source: {{source}}', source: String(props.source ?? '') })}
      </Text>
      {open ? (
        <MapSheet
          title={markers.length === 1 ? String(markers[0]!.props.label) : t('genui.map', 'Map')}
          data={data}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}
