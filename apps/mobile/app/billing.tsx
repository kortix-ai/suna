import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BillingPage } from '@/components/settings/BillingPage';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';

export default function BillingScreen() {
  const router = useRouter();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();

  const handleClose = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/home');
    }
  };

  const handleChangePlan = React.useCallback(async () => {
    handleClose();
    // If RevenueCat is available, present the native paywall directly
    if (useNativePaywall) {
      log.log('📱 Using RevenueCat paywall from billing');
      setTimeout(async () => {
        await presentUpgradePaywall();
      }, 100);
    } else {
      // Otherwise show the custom plan page
      log.log('📄 Using custom plan page from billing');
      setTimeout(() => router.push('/plans'), 100);
    }
  }, [useNativePaywall, presentUpgradePaywall, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <BillingPage
        visible={true}
        onClose={handleClose}
        onChangePlan={handleChangePlan}
      />
    </GestureHandlerRootView>
  );
}
