import React, { useState, useEffect, useCallback } from 'react';
import { View, Linking, Pressable, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ShoppingCart, Lightbulb, Check, X } from 'lucide-react-native';
import { BillingPeriodToggle } from './BillingPeriodToggle';
import { PricingTierCard } from './PricingTierCard';
import { CreditPurchaseModal } from './CreditPurchaseModal';
import { PRICING_TIERS, getDisplayPrice, type PricingTier, type BillingPeriod } from '@/lib/billing';
import { useSubscription, useSubscriptionCommitment, billingKeys } from '@/lib/billing';
import { startUnifiedPlanCheckout } from '@/lib/billing/unified-checkout';
import { useQueryClient } from '@tanstack/react-query';
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
import BasicSvg from '@/assets/brand/tiers/basic.svg';
import PlusSvg from '@/assets/brand/tiers/plus.svg';
import ProSvg from '@/assets/brand/tiers/pro.svg';
import UltraSvg from '@/assets/brand/tiers/ultra.svg';
import { colorScheme, useColorScheme } from 'nativewind';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

interface PricingSectionProps {
  returnUrl?: string;
  showTitleAndTabs?: boolean;
  hideFree?: boolean;
  insideDialog?: boolean;
  noPadding?: boolean;
  onSubscriptionUpdate?: () => void;
  customTitle?: string;
  onClose?: () => void;
}

export function PricingSection({
  returnUrl,
  showTitleAndTabs = true,
  hideFree = false,
  insideDialog = false,
  noPadding = false,
  onSubscriptionUpdate,
  customTitle,
  onClose,
}: PricingSectionProps) {
  const { t } = useLanguage();
  const { user } = useAuthContext();
  const isUserAuthenticated = !!user;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const { data: subscriptionData, isLoading: isFetchingPlan, error: subscriptionQueryError, refetch: refetchSubscription } = useSubscription({ enabled: isUserAuthenticated });
  const subCommitmentQuery = useSubscriptionCommitment(subscriptionData?.subscription?.id, {
    enabled: isUserAuthenticated
  });

  const isAuthenticated = isUserAuthenticated && !!subscriptionData && subscriptionQueryError === null;
  const currentSubscription = subscriptionData || null;

  // Determine current subscription's billing period (matching frontend exactly)
  // Note: Mobile only supports 'monthly' | 'yearly_commitment', so we map 'yearly' to 'yearly_commitment'
  const getCurrentBillingPeriod = (): BillingPeriod | null => {
    if (!isAuthenticated || !currentSubscription) {
      return null;
    }

    // Use billing_period from API response (most reliable - comes from price_id)
    if (currentSubscription.billing_period) {
      const period = currentSubscription.billing_period;
      // Map 'yearly' to 'yearly_commitment' for mobile
      return period === 'yearly' ? 'yearly_commitment' : period as BillingPeriod;
    }

    // Fallback: Check commitment info
    if (subCommitmentQuery.data?.has_commitment &&
      subCommitmentQuery.data?.commitment_type === 'yearly_commitment') {
      return 'yearly_commitment';
    }

    // Fallback: Try to infer from period length
    if (currentSubscription.subscription?.current_period_end) {
      const periodEnd = typeof currentSubscription.subscription.current_period_end === 'number'
        ? currentSubscription.subscription.current_period_end * 1000
        : new Date(currentSubscription.subscription.current_period_end).getTime();

      const now = Date.now();
      const daysInPeriod = Math.round((periodEnd - now) / (1000 * 60 * 60 * 24));

      // If period is longer than 180 days, likely yearly; otherwise monthly
      if (daysInPeriod > 180) {
        return 'yearly_commitment';
      }
    }

    // Default to monthly if period is short or can't determine
    return 'monthly';
  };

  const currentBillingPeriod = getCurrentBillingPeriod();

  const getDefaultBillingPeriod = useCallback((): BillingPeriod => {
    if (!isAuthenticated || !currentSubscription) {
      return 'yearly_commitment';
    }

    // Use current subscription's billing period if available, otherwise default to yearly_commitment
    return currentBillingPeriod || 'yearly_commitment';
  }, [isAuthenticated, currentSubscription, currentBillingPeriod]);

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(getDefaultBillingPeriod());
  const [planLoadingStates, setPlanLoadingStates] = useState<Record<string, boolean>>({});
  const [showCreditPurchaseModal, setShowCreditPurchaseModal] = useState(false);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);

  useEffect(() => {
    setBillingPeriod(getDefaultBillingPeriod());
  }, [getDefaultBillingPeriod]);

  useEffect(() => {
    if (!selectedTierId && currentSubscription) {
      setSelectedTierId(currentSubscription.tier_key || null);
    }
  }, [currentSubscription, selectedTierId]);

  const handlePlanSelect = (planId: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }));
  };

  const handleSubscriptionUpdate = () => {
    // Invalidate all billing-related queries to force refetch
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    // Also refetch subscription and commitment directly
    refetchSubscription();
    subCommitmentQuery.refetch();
    // Clear loading states
    setTimeout(() => {
      setPlanLoadingStates({});
    }, 1000);
    // Call parent's update handler if provided
    if (onSubscriptionUpdate) {
      onSubscriptionUpdate();
    }
  };

  const handleSubscribe = async (tierKey: string, isDowngrade = false) => {
    if (!isAuthenticated) {
      return;
    }

    if (planLoadingStates[tierKey]) {
      return;
    }

    try {
      handlePlanSelect(tierKey);
      const commitmentType = billingPeriod === 'yearly_commitment' ? 'yearly_commitment' : 'monthly';

      await startUnifiedPlanCheckout(
        tierKey,
        commitmentType,
        () => {
          handleSubscriptionUpdate();
          setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
        },
        () => {
          setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
        }
      );
    } catch (error) {
      console.error('❌ Error processing subscription:', error);
      setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: false }));
    }
  };

  const tiersToShow = PRICING_TIERS.filter(
    (tier) => tier.hidden !== true && (!hideFree || tier.price !== '$0')
  );

  const creditsButtonScale = useSharedValue(1);
  const creditsLinkScale = useSharedValue(1);
  const upgradeButtonScale = useSharedValue(1);
  const closeButtonScale = useSharedValue(1);

  const creditsButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsButtonScale.value }],
  }));

  const creditsLinkStyle = useAnimatedStyle(() => ({
    transform: [{ scale: creditsLinkScale.value }],
  }));

  const upgradeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: upgradeButtonScale.value }],
  }));

  const closeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeButtonScale.value }],
  }));

  const getCurrentPlanValue = (): number => {
    if (!currentSubscription?.tier_key) return 0;
    const tierValues: Record<string, number> = {
      'free': 0,
      'tier_2_20': 20,
      'tier_6_50': 50, 
      'tier_12_100': 100,
      'tier_25_200': 200,
    };
    return tierValues[currentSubscription.tier_key] || 0;
  };

  const getSelectedPlanValue = (): number => {
    if (!selectedTierId) return 0;
    const tierValues: Record<string, number> = {
      'free': 0,
      'tier_2_20': 20,
      'tier_6_50': 50,
      'tier_12_100': 100, 
      'tier_25_200': 200,
    };
    return tierValues[selectedTierId] || 0;
  };

  const currentPlanValue = getCurrentPlanValue();
  const selectedPlanValue = getSelectedPlanValue();
  const isUpgrade = selectedPlanValue > currentPlanValue;
  const isDowngrade = selectedPlanValue < currentPlanValue;
  const isCurrentPlan = selectedTierId === currentSubscription?.tier_key && 
    currentSubscription?.subscription?.status === 'active';

  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const isSameTierDifferentPeriod = currentSubscription?.tier_key === selectedTierId && 
    currentBillingPeriod !== billingPeriod && 
    currentBillingPeriod !== null;

  const getMainButtonText = (): string => {
    if (!isAuthenticated) {
      return t('billing.getStarted');
    }
    
    if (isCurrentPlan && !isSameTierDifferentPeriod) {
      return t('billing.currentPlan');
    }
    
    if (isSameTierDifferentPeriod) {
      return billingPeriod === 'yearly_commitment' ? t('billing.upgrade') : t('billing.switchPlan');
    }
    
    if (isUpgrade) {
      return t('billing.upgradeNow');
    }
    
    if (isDowngrade) {
      return t('billing.downgrade');
    }
    
    return t('billing.selectPlan');
  };

  const handleMainButtonPress = async () => {
    if (!selectedTierId) return;
    if (isCurrentPlan && !isSameTierDifferentPeriod) return;
    
    await handleSubscribe(selectedTierId, isDowngrade);
  };

  const isMainButtonDisabled = !selectedTierId || (isCurrentPlan && !isSameTierDifferentPeriod);
  const isLoadingMainButton = selectedTierId ? planLoadingStates[selectedTierId] : false;

  const selectedTier = tiersToShow.find(t => t.id === selectedTierId);

  const getTierIcon = (tierName: string) => {
    switch (tierName.toLowerCase()) {
      case 'basic':
        return BasicSvg;
      case 'plus':
        return PlusSvg;
      case 'pro':
      case 'business':
        return ProSvg;
      case 'ultra':
        return UltraSvg;
      default:
        return BasicSvg;
    }
  };

  return (
    <View className={`flex-1 ${noPadding ? 'pb-0' : ''}`}>
      {onClose && (
        <AnimatedView 
          entering={FadeIn.duration(400)}
          className="px-6 -mt-6 flex-row justify-between items-center bg-background border-b border-border/30"
          style={{ paddingTop: insets.top + 16 }}
        >
          <View>
            <KortixLogo variant="logomark" size={72} color={isDark ? 'dark' : 'light'} />
          </View>
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
          className="px-6 mb-4 flex flex-col items-center"
        >
          <Text className="text-2xl font-roobert-semibold text-foreground mb-4">
            {customTitle || t('billing.choosePlan')}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setBillingPeriod('monthly');
              }}
              className={`px-4 py-2 rounded-full ${
                billingPeriod === 'monthly'
                  ? 'bg-foreground'
                  : 'bg-muted/30'
              }`}
            >
              <Text
                className={`text-sm font-roobert-medium ${
                  billingPeriod === 'monthly'
                    ? 'text-background'
                    : 'text-muted-foreground'
                }`}
              >
                {t('billing.monthly')}
              </Text>
            </AnimatedPressable>
            
            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setBillingPeriod('yearly_commitment');
              }}
              className={`px-4 py-2 rounded-full flex-row items-center gap-1.5 ${
                billingPeriod === 'yearly_commitment'
                  ? 'bg-foreground'
                  : 'bg-muted/30'
              }`}
            >
              <Text
                className={`text-sm font-roobert-medium ${
                  billingPeriod === 'yearly_commitment'
                    ? 'text-background'
                    : 'text-muted-foreground'
                }`}
              >
                {t('billing.yearlyCommitment')}
              </Text>
              <View className="bg-primary/20 px-1.5 py-0.5 rounded-full">
                <Text className="text-[10px] font-roobert-semibold text-primary">
                  {t('billing.save15Percent')}
                </Text>
              </View>
            </AnimatedPressable>
          </View>
        </AnimatedView>

        <AnimatedView 
          entering={FadeIn.duration(600).delay(100)} 
          className="px-6 mb-6 bg-primary/5 rounded-3xl p-6 mx-6"
        >
          {selectedTier && selectedTier.features && selectedTier.features.length > 0 ? (
            selectedTier.features.map((feature, idx) => (
              <View key={idx} className="flex-row items-start gap-3 mb-4 last:mb-0">
                <View className="mt-0.5">
                  <Icon as={Check} size={18} className="text-foreground" strokeWidth={2.5} />
                </View>
                <View className="flex-1">
                  <Text className="text-[15px] text-foreground font-roobert leading-snug">
                    {feature}
                  </Text>
                </View>
              </View>
            ))
          ) : (
            <View className="flex-row items-start gap-3 mb-4">
              <View className="mt-0.5">
                <Icon as={Check} size={18} className="text-foreground" strokeWidth={2.5} />
              </View>
              <View className="flex-1">
                <Text className="text-[15px] text-muted-foreground font-roobert leading-snug">
                  {t('billing.selectPlan')}
                </Text>
              </View>
            </View>
          )}
        </AnimatedView>

        <AnimatedView 
          entering={FadeIn.duration(600).delay(200)} 
          className="px-6 mb-6"
        >
          {tiersToShow.map((tier, index) => {
            const displayPrice = getDisplayPrice(tier, billingPeriod);
            const isSelected = selectedTierId === tier.id;
            const tierIsCurrentPlan = isAuthenticated && 
              currentSubscription?.tier_key === tier.id &&
              currentSubscription?.subscription?.status === 'active';

            return (
              <AnimatedPressable
                key={tier.id}
                entering={FadeIn.duration(600).delay(300 + index * 100)}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedTierId(tier.id);
                }}
                className={`mb-3 border-[1px] rounded-3xl p-4 flex-row items-center ${
                  isSelected 
                    ? 'border-foreground bg-muted/20' 
                    : 'border-border/60 bg-transparent'
                }`}
              >
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
                      {tier?.displayName || tier?.name || 'Plan'}
                    </Text>
                    {tier.isPopular && (
                      <View className="bg-primary rounded-full px-2 py-0.5">
                        <Text className="text-[10px] font-roobert-semibold text-primary-foreground uppercase tracking-wide">
                          {t('billing.mostPopular')}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                <Text className="text-lg font-roobert-semibold text-foreground">
                  {displayPrice}{t('billing.perMonth')}
                </Text>
              </AnimatedPressable>
            );
          })}
        </AnimatedView>
        {isAuthenticated &&
          currentSubscription?.credits?.can_purchase_credits && (
            <AnimatedView 
              entering={FadeIn.duration(600).delay(600)} 
              className="w-full mt-4 flex items-center"
            >
              <AnimatedPressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowCreditPurchaseModal(true);
                }}
                onPressIn={() => {
                  creditsButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  creditsButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                style={creditsButtonStyle}
                className="h-12 border border-border rounded-2xl items-center justify-center flex-row gap-2 px-6 bg-card/50"
              >
                <Icon as={ShoppingCart} size={20} className="text-foreground" strokeWidth={2.5} />
                <Text className="text-base font-roobert-medium text-foreground">
                  {t('billing.addCredits')}
                </Text>
              </AnimatedPressable>
            </AnimatedView>
          )}
      </AnimatedScrollView>

      <AnimatedView 
        entering={FadeIn.duration(600).delay(500)} 
        className="px-6 py-4 bg-background border-t border-border/30"
      >
          <AnimatedPressable
            onPress={handleMainButtonPress}
            disabled={isMainButtonDisabled || isLoadingMainButton}
            onPressIn={() => {
              if (!isMainButtonDisabled && !isLoadingMainButton) {
                upgradeButtonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
              }
            }}
            onPressOut={() => {
              upgradeButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            style={[
              upgradeButtonStyle,
              {
                opacity: isMainButtonDisabled ? 0.5 : 1,
              }
            ]}
            className={`w-full h-14 rounded-full items-center justify-center ${
              isMainButtonDisabled 
                ? 'bg-muted' 
                : 'bg-foreground'
            }`}
          >
            {isLoadingMainButton ? (
              <View className="w-6 h-6 border-2 border-background border-t-transparent rounded-full animate-spin" />
            ) : (
              <Text className={`text-base font-roobert-semibold ${
                isMainButtonDisabled ? 'text-muted-foreground' : 'text-background'
              }`}>
                {getMainButtonText()}
              </Text>
            )}
          </AnimatedPressable>
          
          <AnimatedPressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              Linking.openURL('https://kortix.com/help/credits-explained');
            }}
            onPressIn={() => {
              creditsLinkScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              creditsLinkScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            style={creditsLinkStyle}
            className="flex-row items-center justify-center gap-2 px-3 py-2 mt-2"
          >
            <Icon as={Lightbulb} size={14} className="text-muted-foreground" strokeWidth={2} />
            <Text className="text-sm font-roobert text-muted-foreground">
              Credits explained
            </Text>
          </AnimatedPressable>
      </AnimatedView>

      <CreditPurchaseModal
        open={showCreditPurchaseModal}
        onOpenChange={setShowCreditPurchaseModal}
        currentBalance={currentSubscription?.credits?.balance || 0}
        canPurchase={currentSubscription?.credits?.can_purchase_credits || false}
        onPurchaseComplete={handleSubscriptionUpdate}
      />
    </View>
  );
}
