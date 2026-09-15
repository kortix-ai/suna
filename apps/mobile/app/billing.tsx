import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BillingPage } from '@/components/settings/BillingPage';

export default function BillingScreen() {
  const router = useRouter();

  const handleClose = React.useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/'); // the last project (app/index.tsx), never the list
    }
  }, [router]);

  // Plans opens on top of Billing, so Go back on Plans returns here.
  const openPlans = React.useCallback(() => router.push('/plans'), [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <BillingPage visible={true} onClose={handleClose} onChangePlan={openPlans} />
    </GestureHandlerRootView>
  );
}
