import { Stack } from 'expo-router';
import { PlanPage } from '@/components/settings/PlanPage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import { useLanguage } from '@/contexts';
import { useLocalSearchParams } from 'expo-router';

export default function PlansScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const { creditsExhausted } = useLocalSearchParams<{ creditsExhausted?: string }>();

  const handleClose = () => {
    router.back();
  };

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    setTimeout(() => {
      router.back();
    }, 500);
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false }} />
      <PlanPage
        visible={true}
        onClose={handleClose}
        onPurchaseComplete={handleSubscriptionUpdate}
        customTitle={creditsExhausted === 'true' ? t('billing.ranOutOfCredits') : undefined}
      />
    </GestureHandlerRootView>
  );
}
