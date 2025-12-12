import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { PlanPage } from '@/components/settings/PlanPage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import { useLanguage } from '@/contexts';
import { useLocalSearchParams } from 'expo-router';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { Text } from '@/components/ui/text';

export default function PlansScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const { creditsExhausted } = useLocalSearchParams<{ creditsExhausted?: string }>();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const [hasPresented, setHasPresented] = useState(false);

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

  // If RevenueCat is available, present the native paywall immediately
  useEffect(() => {
    if (useNativePaywall && !hasPresented) {
      setHasPresented(true);
      const presentPaywall = async () => {
        console.log('📱 Plans screen: Using native RevenueCat paywall');
        const result = await presentUpgradePaywall();

        if (result.purchased) {
          // Purchase successful - handle subscription update
          handleSubscriptionUpdate();
        } else {
          // Cancelled or dismissed - go back
          handleClose();
        }
      };

      // Small delay to ensure navigation is complete
      setTimeout(presentPaywall, 300);
    }
  }, [useNativePaywall, hasPresented, presentUpgradePaywall]);

  // If RevenueCat is available, show loading while we present the paywall
  if (useNativePaywall) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 items-center justify-center bg-background">
          <ActivityIndicator size="large" />
          <Text className="mt-4 text-muted-foreground">
            {t('billing.loadingPaywall', 'Loading plans...')}
          </Text>
        </View>
      </GestureHandlerRootView>
    );
  }

  // Otherwise show the custom PlanPage
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
