import * as React from 'react';
import { View, Pressable, Dimensions, ScrollView } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowRight, MessageSquare, Zap, Shield, Sparkles, CheckCircle, CreditCard } from 'lucide-react-native';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
  Extrapolate,
} from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { useBillingContext } from '@/contexts/BillingContext';
import { 
  TrialCard, 
  PricingTierCard, 
  BillingPeriodSelector 
} from '@/components/billing';
import { 
  PRICING_TIERS, 
  BillingPeriod, 
  getPriceId, 
  getDisplayPrice, 
  startPlanCheckout, 
  startTrialCheckout 
} from '@/lib/billing';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ONBOARDING_KEY = '@onboarding_completed';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface OnboardingSlide {
  id: string;
  icon: typeof MessageSquare;
  title: string;
  description: string;
  color: string;
}

/**
 * Onboarding Screen
 * 
 * Protected by root layout AuthProtection - requires authentication
 * Welcome flow for first-time users after authentication
 * Shows key features, benefits, and ends with billing/trial selection
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { trialStatus, refetchAll, hasActiveTrial, hasActiveSubscription } = useBillingContext();
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const scrollX = useSharedValue(0);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  const canStartTrial = trialStatus?.can_start_trial ?? false;
  
  // If user already has billing, skip directly to completion
  React.useEffect(() => {
    if (hasActiveTrial || hasActiveSubscription) {
      console.log('✅ User already has billing, completing onboarding automatically');
      handleComplete();
    }
  }, [hasActiveTrial, hasActiveSubscription]);

  const totalSlides = canStartTrial ? 5 : 5; // 4 info slides + 1 billing slide

  const slides: OnboardingSlide[] = [
    {
      id: '1',
      icon: MessageSquare,
      title: t('onboarding.slide1.title'),
      description: t('onboarding.slide1.description'),
      color: '#3B82F6', // Blue
    },
    {
      id: '2',
      icon: Zap,
      title: t('onboarding.slide2.title'),
      description: t('onboarding.slide2.description'),
      color: '#F59E0B', // Amber
    },
    {
      id: '3',
      icon: Shield,
      title: t('onboarding.slide3.title'),
      description: t('onboarding.slide3.description'),
      color: '#10B981', // Green
    },
    {
      id: '4',
      icon: Sparkles,
      title: t('onboarding.slide4.title'),
      description: t('onboarding.slide4.description'),
      color: '#8B5CF6', // Purple
    },
  ];

  const handleComplete = React.useCallback(async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Refetch billing data before routing
      refetchAll();
      
      router.replace('/home');
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      router.replace('/home');
    }
  }, [refetchAll, router]);

  const handleNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentSlide < totalSlides - 1) {
      const nextSlide = currentSlide + 1;
      setCurrentSlide(nextSlide);
      scrollViewRef.current?.scrollTo({
        x: nextSlide * SCREEN_WIDTH,
        animated: true,
      });
    }
    // Don't auto-complete on last slide (billing) - user must select plan
  };

  const handleSkip = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Jump to billing slide (last slide)
    const billingSlideIndex = totalSlides - 1;
    setCurrentSlide(billingSlideIndex);
    scrollViewRef.current?.scrollTo({
      x: billingSlideIndex * SCREEN_WIDTH,
      animated: true,
    });
  };

  const handleScroll = (event: any) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    scrollX.value = offsetX;
    const newSlide = Math.round(offsetX / SCREEN_WIDTH);
    setCurrentSlide(newSlide);
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        {/* Header with Skip */}
        <View className="pt-16 px-6 pb-4 flex-row justify-between items-center">
          <Logomark width={120} height={24} />
          {currentSlide < totalSlides - 1 && (
            <Pressable onPress={handleSkip}>
              <Text className="text-[15px] font-roobert-medium text-muted-foreground">
                {t('onboarding.skip')}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Slides */}
        <ScrollView
          ref={scrollViewRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          bounces={false}
        >
          {slides.map((slide, index) => (
            <OnboardingSlide
              key={slide.id}
              slide={slide}
              index={index}
              scrollX={scrollX}
            />
          ))}
          {/* Billing Slide */}
          <BillingSlide
            index={slides.length}
            scrollX={scrollX}
            canStartTrial={canStartTrial}
            onSuccess={handleComplete}
            t={t}
          />
        </ScrollView>

        {/* Pagination Dots */}
        <View className="flex-row justify-center gap-2 mb-6">
          {Array.from({ length: totalSlides }).map((_, index) => (
            <PaginationDot
              key={index}
              index={index}
              currentIndex={currentSlide}
              scrollX={scrollX}
            />
          ))}
        </View>

        {/* Next/Get Started Button - Only show on non-billing slides */}
        {currentSlide < totalSlides - 1 && (
          <View className="px-6 pb-8">
            <ContinueButton
              onPress={handleNext}
              isLast={false}
              t={t}
            />
          </View>
        )}
      </View>
    </>
  );
}

/**
 * Onboarding Slide Component
 */
interface OnboardingSlideProps {
  slide: OnboardingSlide;
  index: number;
  scrollX: Animated.SharedValue<number>;
}

function OnboardingSlide({ slide, index, scrollX }: OnboardingSlideProps) {
  const { colorScheme } = useColorScheme();

  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const scale = interpolate(
      scrollX.value,
      inputRange,
      [0.8, 1, 0.8],
      Extrapolate.CLAMP
    );

    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.3, 1, 0.3],
      Extrapolate.CLAMP
    );

    return {
      transform: [{ scale }],
      opacity,
    };
  });

  const IconComponent = slide.icon;

  return (
    <View
      style={{ width: SCREEN_WIDTH }}
      className="flex-1 items-center justify-center px-8"
    >
      <Animated.View style={animatedStyle} className="items-center">
        {/* Icon Container */}
        <View
          className="size-24 rounded-3xl items-center justify-center mb-8"
          style={{
            backgroundColor:
              colorScheme === 'dark'
                ? 'rgba(255, 255, 255, 0.1)'
                : 'rgba(0, 0, 0, 0.05)',
          }}
        >
          <IconComponent
            size={48}
            color={slide.color}
            strokeWidth={2}
          />
        </View>

        {/* Title */}
        <Text className="text-3xl font-roobert-semibold text-foreground text-center mb-4">
          {slide.title}
        </Text>

        {/* Description */}
        <Text className="text-[17px] font-roobert text-muted-foreground text-center leading-6">
          {slide.description}
        </Text>
      </Animated.View>
    </View>
  );
}

/**
 * Pagination Dot Component
 */
interface PaginationDotProps {
  index: number;
  currentIndex: number;
  scrollX: Animated.SharedValue<number>;
}

function PaginationDot({ index, scrollX }: PaginationDotProps) {
  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const width = interpolate(
      scrollX.value,
      inputRange,
      [8, 24, 8],
      Extrapolate.CLAMP
    );

    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.3, 1, 0.3],
      Extrapolate.CLAMP
    );

    return {
      width,
      opacity,
    };
  });

  return (
    <Animated.View
      style={animatedStyle}
      className="h-2 rounded-full bg-primary"
    />
  );
}

/**
 * Continue Button Component
 */
interface ContinueButtonProps {
  onPress: () => void;
  isLast: boolean;
  t: (key: string) => string;
}

function ContinueButton({ onPress, isLast, t }: ContinueButtonProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      style={animatedStyle}
      className="bg-primary h-14 rounded-2xl flex-row items-center justify-center gap-2"
    >
      <Text className="text-[17px] font-roobert-semibold text-primary-foreground">
        {isLast ? t('onboarding.getStarted') : t('onboarding.next')}
      </Text>
      <Icon as={ArrowRight} size={20} className="text-primary-foreground" />
    </AnimatedPressable>
  );
}

/**
 * Billing Slide Component - Simplified using BillingContent
 */
interface BillingSlideProps {
  index: number;
  scrollX: Animated.SharedValue<number>;
  canStartTrial: boolean;
  onSuccess: () => void;
  t: (key: string, defaultValue?: string) => string;
}

function BillingSlide({
  index,
  scrollX,
  canStartTrial,
  onSuccess,
  t,
}: BillingSlideProps) {
  const [billingPeriod, setBillingPeriod] = React.useState<BillingPeriod>('yearly_commitment');
  const [selectedPlan, setSelectedPlan] = React.useState<string | null>(null);

  const handleStartTrial = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedPlan('trial');
    
    try {
      await startTrialCheckout(
        () => {
          setSelectedPlan(null);
          onSuccess();
        },
        () => {
          setSelectedPlan(null);
        }
      );
    } catch (error) {
      console.error('❌ Error starting trial:', error);
      setSelectedPlan(null);
    }
  };

  const handleSelectPlan = async (tier: typeof PRICING_TIERS[0]) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectedPlan(tier.name);

    const priceId = getPriceId(tier, billingPeriod);
    if (!priceId) {
      console.error('❌ No price ID found for tier:', tier.name, billingPeriod);
      setSelectedPlan(null);
      return;
    }

    try {
      await startPlanCheckout(
        priceId,
        billingPeriod,
        () => {
          setSelectedPlan(null);
          onSuccess();
        },
        () => {
          setSelectedPlan(null);
        }
      );
    } catch (error) {
      console.error('❌ Error starting checkout:', error);
      setSelectedPlan(null);
    }
  };

  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const scale = interpolate(
      scrollX.value,
      inputRange,
      [0.8, 1, 0.8],
      Extrapolate.CLAMP
    );

    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.3, 1, 0.3],
      Extrapolate.CLAMP
    );

    return {
      transform: [{ scale }],
      opacity,
    };
  });

  const tiersToShow = PRICING_TIERS.slice(0, 2); // Show only first 2 tiers for onboarding

  return (
    <View
      style={{ width: SCREEN_WIDTH }}
      className="flex-1 px-6 pt-4"
    >
      <Animated.View style={animatedStyle} className="flex-1">
        <ScrollView showsVerticalScrollIndicator={false} className="flex-1 pb-6">
          {/* Title */}
          <View className="mb-6">
            <Text className="text-2xl font-roobert-semibold text-foreground text-center mb-2">
              {canStartTrial 
                ? t('billing.trial.title', 'Start Your Free Trial') 
                : t('billing.subscription.title', 'Choose Your Plan')
              }
            </Text>
            <Text className="text-[15px] text-muted-foreground text-center">
              {t('billing.subtitle', 'Select a plan to get started')}
            </Text>
          </View>

          {/* Free Trial Card */}
          {canStartTrial && (
            <TrialCard
              onPress={handleStartTrial}
              disabled={selectedPlan === 'trial'}
              t={t}
            />
          )}

          {/* Period Selector - Only if no trial */}
          {!canStartTrial && (
            <BillingPeriodSelector
              selected={billingPeriod}
              onChange={setBillingPeriod}
              t={t}
            />
          )}

          {/* Pricing Tiers - Only top 2 for onboarding */}
          {!canStartTrial && (
            <View className="space-y-3">
              {tiersToShow.map((tier) => {
                const displayPrice = getDisplayPrice(tier, billingPeriod);
                const isSelected = selectedPlan === tier.name;

                return (
                  <PricingTierCard
                    key={tier.name}
                    tier={tier}
                    displayPrice={displayPrice}
                    billingPeriod={billingPeriod}
                    isSelected={isSelected}
                    onSelect={() => handleSelectPlan(tier)}
                    disabled={isSelected}
                    simplified={true}
                    t={t}
                  />
                );
              })}
            </View>
          )}

          {/* Footer */}
          <View className="mt-6 p-4 bg-muted/50 rounded-lg">
            <Text className="text-xs text-center text-muted-foreground">
              {t('billing.footer', 'Cancel anytime. No questions asked.')}
            </Text>
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

