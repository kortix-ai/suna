import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { PlanPage } from '@/components/settings/PlanPage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import { useLanguage } from '@/contexts';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { Text } from '@/components/ui/text';
import { log } from '@/lib/logger';

export default function PlansScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const [hasPresented, setHasPresented] = useState(false);
  // Track if we should fall back to custom page (e.g., no paywall template configured)
  const [showCustomPage, setShowCustomPage] = useState(false);

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
    if (useNativePaywall && !hasPresented && !showCustomPage) {
      setHasPresented(true);
      const presentPaywall = async () => {
        log.log('📱 Plans screen: Using native RevenueCat paywall');
        const result = await presentUpgradePaywall() as any;

        if (result.purchased) {
          // Purchase successful - handle subscription update
          handleSubscriptionUpdate();
        } else if (result.needsCustomPage) {
          // RevenueCat paywall not available (no template configured) - show custom page
          log.log('📱 Plans screen: Falling back to custom plan page');
          setShowCustomPage(true);
        } else {
          // Cancelled or dismissed - go back
          handleClose();
        }
      };

      // Small delay to ensure navigation is complete
      setTimeout(presentPaywall, 300);
    }
  }, [useNativePaywall, hasPresented, presentUpgradePaywall, showCustomPage]);

  // If we need to show the custom page as fallback, show it
  if (showCustomPage || !useNativePaywall) {
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

  // Show loading while we present the RevenueCat paywall
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
