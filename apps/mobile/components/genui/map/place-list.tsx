/**
 * The places of a Map as rows: with the map switched off, and (Task 6) when the basemap fails. Each row is the
 * name, its note, and the place card's actions (web `PlaceCard`): Directions, then Website and Call when the
 * place has them.
 */
import { safeUrl } from '@kortix/sdk/genui';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { telLink, type MapPlace, type PlaceAction } from '@/lib/genui/map-geo';

import { openPlaceAction } from '../components/open-link';

function PlaceRow({ place }: { place: MapPlace }) {
  const { t } = useTranslation();
  const action = (kind: PlaceAction, label: string) => (
    <Button
      size="sm"
      variant={kind === 'directions' ? 'default' : 'secondary'}
      className="flex-1 rounded-full"
      accessibilityLabel={`${label}: ${place.label}`}
      onPress={() => openPlaceAction(place, kind)}
    >
      <Text>{label}</Text>
    </Button>
  );
  return (
    <View className="gap-3 px-4 py-3">
      <View className="gap-0.5">
        <Text className="font-medium">{place.label}</Text>
        {place.description ? <Text variant="muted">{place.description}</Text> : null}
      </View>
      <View className="flex-row gap-2">
        {action('directions', t('genui.directions', 'Directions'))}
        {safeUrl(place.href) ? action('website', t('genui.website', 'Website')) : null}
        {telLink(place.phone) ? action('call', t('genui.call', 'Call')) : null}
      </View>
    </View>
  );
}

export function GenuiPlaceList({ places }: { places: MapPlace[] }) {
  const { t } = useTranslation();
  // Every marker dropped (off the globe): web keeps the empty card; here the card says so instead of
  // collapsing the block the pending box held.
  if (!places.length) {
    return (
      <View className="rounded-2xl bg-card px-4 py-3">
        <Text variant="muted">{t('genui.mapUnavailable', 'Map unavailable')}</Text>
      </View>
    );
  }
  return (
    <View className="rounded-2xl bg-card">
      {places.map((place, i) => (
        <Fragment key={place.id}>
          {i > 0 ? <Separator /> : null}
          <PlaceRow place={place} />
        </Fragment>
      ))}
    </View>
  );
}
