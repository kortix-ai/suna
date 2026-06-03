import { Stack } from 'expo-router';
import { PlanPage } from '@/components/settings/PlanPage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';

export default function PlansScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const handleClose = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/home');
    }
  };

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    setTimeout(() => {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/home');
      }
    }, 1500);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <PlanPage
        visible={true}
        onClose={handleClose}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </GestureHandlerRootView>
  );
}
