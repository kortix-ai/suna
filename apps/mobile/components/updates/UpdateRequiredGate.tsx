/**
 * Minimum-version gate (P4.6). Reads the API's mobile release policy
 * (`GET /v1/clients/mobile`, public: it runs before login) and covers the app
 * with a blocking "Update required" screen when this binary is older than
 * `minimum_version`. Mounted once in `app/_layout.tsx`, over the navigator.
 *
 * Fails open: an error, a non-200 answer, a null or unparsable minimum, or an
 * unknown own version never shows the gate. The gate lives in the JS bundle,
 * so an OTA update delivers it to every build with the same `runtimeVersion`.
 *
 * The policy refetches on return to the foreground once it is 5 minutes old
 * (the query client's `focusManager` follows `AppState`).
 */

import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Constants from 'expo-constants';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { compareSemver, getMobileClientPolicy } from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';

const POLICY_STALE_MS = 5 * 60 * 1000;

export function UpdateRequiredGate() {
  const { t } = useTranslation();
  const { data: policy } = useQuery({
    queryKey: ['client-policy', 'mobile'],
    queryFn: ({ signal }) => getMobileClientPolicy({ signal }),
    staleTime: POLICY_STALE_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const appVersion = Constants.nativeAppVersion ?? Constants.expoConfig?.version;
  const below =
    !!appVersion && !!policy?.minimum_version && compareSemver(appVersion, policy.minimum_version) === -1;
  if (!policy || !below) return null;

  const storeUrl = Platform.OS === 'ios' ? policy.store_url_ios : Platform.OS === 'android' ? policy.store_url_android : null;

  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 10000 }]}
      className="items-center justify-center gap-3 bg-background px-6">
      <Text variant="h4" className="text-center">
        {t('updateRequired.title')}
      </Text>
      <Text variant="muted" className="text-center">
        {t(storeUrl ? 'updateRequired.body' : 'updateRequired.bodyNoStore')}
      </Text>
      {storeUrl ? (
        <Button
          size="lg"
          className="mt-3 rounded-full"
          onPress={() => openLink(storeUrl).catch((error) => log.error('❌ Update: cannot open the store:', error))}>
          <Text>{t('updateRequired.button')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
