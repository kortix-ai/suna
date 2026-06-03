import * as React from 'react';
import { Stack, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BillingPage } from '@/components/settings/BillingPage';

export default function BillingScreen() {
  const router = useRouter();

  const handleClose = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/home');
    }
  };

  const handleChangePlan = React.useCallback(async () => {
    handleClose();
    setTimeout(() => router.push('/plans'), 100);
  }, [router]);

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
