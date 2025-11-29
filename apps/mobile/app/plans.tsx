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
    if (router.canGoBack()) {
      router.back();
    } else {
      // If no previous screen, navigate to home
      router.replace('/home');
    }
  };

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    // Wait longer to ensure subscription state is fully updated before navigating
    // This prevents auth/logout issues during navigation
    setTimeout(() => {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/home');
      }
    }, 1500); // Increased from 500ms to 1500ms to allow state to settle
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
