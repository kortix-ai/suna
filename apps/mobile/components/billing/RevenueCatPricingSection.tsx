import React, { useState, useEffect } from 'react';
import { View, Pressable, ScrollView, ActivityIndicator, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check, X, ShoppingCart } from 'lucide-react-native';
import { useAuthContext } from '@/contexts';
import { useLanguage } from '@/contexts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import { KortixLogo } from '../ui/KortixLogo';
import { useColorScheme } from 'nativewind';
import { getOfferings, purchasePackage, type RevenueCatProduct } from '@/lib/billing/revenuecat';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys, useSubscription } from '@/lib/billing';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

interface RevenueCatPricingSectionProps {
  onClose?: () => void;
  onPurchaseComplete?: () => void;
  customTitle?: string;
}

export function RevenueCatPricingSection({
  onClose,
  onPurchaseComplete,
  customTitle,
}: RevenueCatPricingSectionProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const queryClient = useQueryClient();

  const { data: subscriptionData, refetch: refetchSubscription } = useSubscription({ enabled: !!user });

  const [offerings, setOfferings] = useState<PurchasesOffering | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPackage, setSelectedPackage] = useState<PurchasesPackage | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeButtonScale = useSharedValue(1);
  const purchaseButtonScale = useSharedValue(1);
  const restoreButtonScale = useSharedValue(1);

  const closeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeButtonScale.value }],
  }));

  const purchaseButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: purchaseButtonScale.value }],
  }));

  const restoreButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: restoreButtonScale.value }],
  }));

  useEffect(() => {
    loadOfferings();
  }, []);

  const loadOfferings = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const fetchedOfferings = await getOfferings();
      
      if (fetchedOfferings) {
        setOfferings(fetchedOfferings);
        if (fetchedOfferings.availablePackages.length > 0) {
          setSelectedPackage(fetchedOfferings.availablePackages[0]);
        }
      } else {
        setError('No offerings available');
      }
    } catch (err: any) {
      console.error('Error loading offerings:', err);
      setError(err.message || 'Failed to load offerings');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePurchase = async () => {
    if (!selectedPackage || isPurchasing) return;

    try {
      setIsPurchasing(true);
      setError(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      await purchasePackage(selectedPackage, user?.email);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
      
      await refetchSubscription();
      
      onPurchaseComplete?.();
      onClose?.();
    } catch (err: any) {
      if (!err.userCancelled) {
        console.error('Purchase error:', err);
        setError(err.message || 'Purchase failed');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setIsPurchasing(false);
    }
  };

  const handleRestorePurchases = async () => {
    if (isRestoring) return;

    try {
      setIsRestoring(true);
      setError(null);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      console.log('🔄 Restoring purchases...');
      const { restorePurchases } = await import('@/lib/billing/revenuecat');
      const customerInfo = await restorePurchases(user?.email);

      console.log('✅ Purchases restored:', customerInfo);

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
      
      await refetchSubscription();
      
      onPurchaseComplete?.();
      onClose?.();
    } catch (err: any) {
      console.error('❌ Restore error:', err);
      setError(err.message || 'Failed to restore purchases');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsRestoring(false);
    }
  };

  const getPackageType = (pkg: PurchasesPackage): string => {
    const identifier = pkg.identifier.toLowerCase();
    
    if (identifier.includes('commitment')) {
      return 'Yearly Commitment';
    }
    if (identifier.includes('annual') || identifier.includes('yearly')) {
      return 'Yearly';
    }
    if (identifier.includes('monthly')) {
      return 'Monthly';
    }
    if (identifier.includes('lifetime')) {
      return 'Lifetime';
    }
    return 'Subscription';
  };

  const isMonthlyPackage = (pkg: PurchasesPackage): boolean => {
    const identifier = pkg.identifier.toLowerCase();
    return identifier.includes('monthly');
  };

  const isPopularPackage = (pkg: PurchasesPackage): boolean => {
    const identifier = pkg.identifier.toLowerCase();
    return identifier.includes('pro') || identifier.includes('plus');
  };

  const isCurrentPlan = (pkg: PurchasesPackage): boolean => {
    if (!subscriptionData || subscriptionData.provider !== 'revenuecat') {
      return false;
    }
    
    const currentProductId = subscriptionData.revenuecat_product_id || '';
    const packageProductId = pkg.product.identifier;
    const packageIdentifier = pkg.identifier;
    
    return currentProductId.toLowerCase() === packageProductId.toLowerCase() ||
           currentProductId.toLowerCase() === packageIdentifier.toLowerCase();
  };

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" />
        <Text className="mt-4 text-muted-foreground">Loading plans...</Text>
      </View>
    );
  }

  if (error || !offerings) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-xl font-roobert-semibold text-foreground mb-2">
          Unable to load plans
        </Text>
        <Text className="text-muted-foreground text-center mb-4">
          {error || 'Please try again later'}
        </Text>
        <Pressable
          onPress={loadOfferings}
          className="bg-primary px-6 py-3 rounded-full"
        >
          <Text className="text-primary-foreground font-roobert-medium">
            Retry
          </Text>
        </Pressable>
      </View>
    );
  }

  const packages = offerings.availablePackages.filter(pkg => isMonthlyPackage(pkg));

  return (
    <View className="flex-1 bg-background">
      {onClose && (
        <AnimatedView 
          entering={FadeIn.duration(400)}
          className="px-6 flex-row justify-between items-center bg-background border-b border-border/30"
          style={{ paddingTop: insets.top + 16, paddingBottom: 16 }}
        >
          <KortixLogo variant="logomark" size={72} color={isDark ? 'dark' : 'light'} />
          <AnimatedPressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
            onPressIn={() => {
              closeButtonScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              closeButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            style={closeButtonStyle}
            className="h-10 w-10 rounded-full bg-primary/10 items-center justify-center"
          >
            <Icon as={X} size={18} className="text-foreground" strokeWidth={2.5} />
          </AnimatedPressable>
        </AnimatedView>
      )}

      <AnimatedScrollView 
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ 
          paddingTop: 16,
          paddingBottom: 16
        }}
      >
        <AnimatedView 
          entering={FadeIn.duration(600).delay(50)} 
          className="px-6 mb-4"
        >
          <Text className="text-2xl font-roobert-semibold text-foreground text-center">
            {customTitle || 'Choose Your Plan'}
          </Text>
        </AnimatedView>

        <AnimatedView 
          entering={FadeIn.duration(600).delay(200)} 
          className="px-6 mb-6"
        >
          {packages.map((pkg, index) => {
            const isSelected = selectedPackage?.identifier === pkg.identifier;
            const packageType = getPackageType(pkg);
            const isPopular = isPopularPackage(pkg);
            const isCurrent = isCurrentPlan(pkg);
            const product = pkg.product;

            return (
              <AnimatedPressable
                key={pkg.identifier}
                entering={FadeIn.duration(600).delay(300 + index * 100)}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedPackage(pkg);
                }}
                className={`mb-3 border-[1px] rounded-3xl p-4 ${
                  isSelected 
                    ? 'border-foreground bg-muted/20' 
                    : 'border-border/60 bg-transparent'
                }`}
              >
                <View className="flex-row items-center">
                  <View 
                    className={`w-6 h-6 rounded-full border-2 items-center justify-center mr-4 ${
                      isSelected 
                        ? 'border-foreground bg-foreground' 
                        : 'border-border/60 bg-transparent'
                    }`}
                  >
                    {isSelected && (
                      <View className="w-3 h-3 rounded-full bg-background" />
                    )}
                  </View>
                  
                  <View className="flex-1">
                    <View className="flex-row items-center gap-2 mb-1">
                      <Text className="text-base font-roobert-semibold text-foreground">
                        {product.title || pkg.identifier}
                      </Text>
                      {isCurrent && (
                        <View className="bg-green-500 rounded-full px-2 py-0.5">
                          <Text className="text-[10px] font-roobert-semibold text-white uppercase tracking-wide">
                            Current
                          </Text>
                        </View>
                      )}
                      {!isCurrent && isPopular && (
                        <View className="bg-primary rounded-full px-2 py-0.5">
                          <Text className="text-[10px] font-roobert-semibold text-primary-foreground uppercase tracking-wide">
                            Popular
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text className="text-sm text-muted-foreground">
                      {packageType}
                    </Text>
                  </View>

                  <Text className="text-lg font-roobert-semibold text-foreground">
                    {product.priceString}
                  </Text>
                </View>

                {product.introPrice && (
                  <View className="mt-2 ml-10 bg-primary/10 rounded-lg px-3 py-2">
                    <Text className="text-xs font-roobert-medium text-primary">
                      {product.introPrice.priceString} for {product.introPrice.period}
                    </Text>
                  </View>
                )}
              </AnimatedPressable>
            );
          })}
        </AnimatedView>

        {selectedPackage && (
          <AnimatedView 
            entering={FadeIn.duration(600).delay(600)} 
            className="px-6 mb-6 bg-primary/5 rounded-3xl p-6 mx-6"
          >
            <Text className="text-base font-roobert-semibold text-foreground mb-3">
              What's included:
            </Text>
            <View className="flex-row items-start gap-3 mb-3">
              <Icon as={Check} size={18} className="text-foreground mt-0.5" strokeWidth={2.5} />
              <Text className="text-[15px] text-foreground font-roobert leading-snug flex-1">
                Access to all AI agents
              </Text>
            </View>
            <View className="flex-row items-start gap-3 mb-3">
              <Icon as={Check} size={18} className="text-foreground mt-0.5" strokeWidth={2.5} />
              <Text className="text-[15px] text-foreground font-roobert leading-snug flex-1">
                Premium support
              </Text>
            </View>
            <View className="flex-row items-start gap-3">
              <Icon as={Check} size={18} className="text-foreground mt-0.5" strokeWidth={2.5} />
              <Text className="text-[15px] text-foreground font-roobert leading-snug flex-1">
                Cancel anytime
              </Text>
            </View>
          </AnimatedView>
        )}
      </AnimatedScrollView>

      <AnimatedView 
        entering={FadeIn.duration(600).delay(500)} 
        className="px-6 py-4 bg-background border-t border-border/30"
      >
        <AnimatedPressable
          onPress={handlePurchase}
          disabled={!selectedPackage || isPurchasing || (selectedPackage && isCurrentPlan(selectedPackage))}
          onPressIn={() => {
            if (selectedPackage && !isPurchasing && !isCurrentPlan(selectedPackage)) {
              purchaseButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
            }
          }}
          onPressOut={() => {
            purchaseButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[
            purchaseButtonStyle,
            {
              opacity: !selectedPackage || isPurchasing || (selectedPackage && isCurrentPlan(selectedPackage)) ? 0.5 : 1,
            }
          ]}
          className={`w-full h-14 rounded-full items-center justify-center ${
            !selectedPackage || isPurchasing || (selectedPackage && isCurrentPlan(selectedPackage))
              ? 'bg-muted' 
              : 'bg-foreground'
          }`}
        >
          {isPurchasing ? (
            <ActivityIndicator color={isDark ? '#000' : '#fff'} />
          ) : (
            <Text className={`text-base font-roobert-semibold ${
              !selectedPackage || (selectedPackage && isCurrentPlan(selectedPackage)) ? 'text-muted-foreground' : 'text-background'
            }`}>
              {!selectedPackage ? 'Select a plan' : isCurrentPlan(selectedPackage) ? 'Current Plan' : 'Continue'}
            </Text>
          )}
        </AnimatedPressable>

        <AnimatedPressable
          onPress={handleRestorePurchases}
          disabled={isRestoring || isPurchasing}
          onPressIn={() => {
            if (!isRestoring && !isPurchasing) {
              restoreButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
            }
          }}
          onPressOut={() => {
            restoreButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[
            restoreButtonStyle,
            {
              opacity: isRestoring || isPurchasing ? 0.5 : 1,
            }
          ]}
          className="w-full h-12 mt-3 items-center justify-center"
        >
          {isRestoring ? (
            <ActivityIndicator color={isDark ? '#fff' : '#000'} size="small" />
          ) : (
            <Text className="text-sm font-roobert-medium text-foreground/70">
              Restore Purchases
            </Text>
          )}
        </AnimatedPressable>

        <View className="flex-row justify-center mt-6 gap-6 mb-2">
          <Pressable onPress={() => Linking.openURL('https://kortix.ai/privacy')}>
            <Text className="text-xs text-muted-foreground/70 font-roobert-medium underline">
              Privacy Policy
            </Text>
          </Pressable>
          <Pressable onPress={() => Linking.openURL('https://kortix.ai/terms')}>
            <Text className="text-xs text-muted-foreground/70 font-roobert-medium underline">
              Terms of Service
            </Text>
          </Pressable>
        </View>

        {error && (
          <Text className="text-sm text-red-500 text-center mt-2">
            {error}
          </Text>
        )}
      </AnimatedView>
    </View>
  );
}

