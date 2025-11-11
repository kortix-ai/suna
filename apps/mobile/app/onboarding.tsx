import * as React from 'react';
import { View, Pressable, Dimensions, ScrollView } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  ArrowRight, 
  Presentation, 
  Search, 
  BarChart3, 
  FileText, 
  Sparkles, 
  Zap,
  LogOut 
} from 'lucide-react-native';
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
  LinearTransition,
  SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useLanguage } from '@/contexts';
import { useBillingContext } from '@/contexts/BillingContext';
import { useAuthContext } from '@/contexts/AuthContext';
import { useAgent } from '@/contexts/AgentContext';
import { 
  PricingTierCard, 
  BillingPeriodSelector 
} from '@/components/billing';
import { 
  PRICING_TIERS, 
  BillingPeriod, 
  getDisplayPrice, 
  startPlanCheckout
} from '@/lib/billing';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ONBOARDING_KEY_PREFIX = '@onboarding_completed_';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface OnboardingSlide {
  id: string;
  icon: typeof Presentation;
  title: string;
  description: string;
  color: string;
  gradient: [string, string];
  example?: string;
}

/**
 * Onboarding Screen
 * 
 * Protected by root layout AuthProtection - requires authentication
 * Welcome flow shown every time user logs in on this device
 * Shows key features and ends with billing (skips billing if already subscribed)
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { hasActiveSubscription } = useBillingContext();
  const { signOut, session } = useAuthContext();
  const { loadAgents } = useAgent();
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const scrollX = useSharedValue(0);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  // If user already has active billing, skip directly to completion (no billing slide needed)
  React.useEffect(() => {
    if (hasActiveSubscription) {
      console.log('✅ User already has active billing, auto-completing onboarding');
      handleComplete();
    }
  }, [hasActiveSubscription]);

  const slides: OnboardingSlide[] = [
    {
      id: '1',
      icon: Presentation,
      title: t('onboarding.slides.title'),
      description: t('onboarding.slides.description'),
      color: '#6366F1',
      gradient: ['#6366F1', '#8B5CF6'],
      example: t('onboarding.slides.example'),
    },
    {
      id: '2',
      icon: Search,
      title: t('onboarding.research.title'),
      description: t('onboarding.research.description'),
      color: '#10B981',
      gradient: ['#10B981', '#14B8A6'],
      example: t('onboarding.research.example'),
    },
    {
      id: '3',
      icon: BarChart3,
      title: t('onboarding.data.title'),
      description: t('onboarding.data.description'),
      color: '#F59E0B',
      gradient: ['#F59E0B', '#EF4444'],
      example: t('onboarding.data.example'),
    },
    {
      id: '4',
      icon: FileText,
      title: t('onboarding.docs.title'),
      description: t('onboarding.docs.description'),
      color: '#3B82F6',
      gradient: ['#3B82F6', '#06B6D4'],
      example: t('onboarding.docs.example'),
    },
    {
      id: '5',
      icon: Sparkles,
      title: t('onboarding.automation.title'),
      description: t('onboarding.automation.description'),
      color: '#8B5CF6',
      gradient: ['#8B5CF6', '#EC4899'],
      example: t('onboarding.automation.example'),
    },
    {
      id: '6',
      icon: Zap,
      title: t('onboarding.superworker.title'),
      description: t('onboarding.superworker.description'),
      color: '#EC4899',
      gradient: ['#EC4899', '#F43F5E'],
      example: t('onboarding.superworker.example'),
    },
  ];

  const totalSlides = slides.length + 1; // feature slides + 1 billing slide

  const handleComplete = React.useCallback(async () => {
    try {
      // Save onboarding completion for this specific user on this device
      const userId = session?.user?.id || 'anonymous';
      const onboardingKey = `${ONBOARDING_KEY_PREFIX}${userId}`;
      await AsyncStorage.setItem(onboardingKey, 'true');
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Refetch billing data and agents before routing
      console.log('🔄 Refetching billing data and agents after onboarding completion...');
      // Note: refetchAll removed - billing context will refetch automatically
      await loadAgents();
      
      console.log(`✅ Onboarding completed for user: ${userId}`);
      router.replace('/home');
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      router.replace('/home');
    }
  }, [loadAgents, router, session?.user?.id]);

  const handleLogout = React.useCallback(async () => {
    try {
      setIsLoggingOut(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      
      console.log('🔓 Logging out from onboarding...');
      await signOut();
      
      // Navigation will be handled by AuthProtection in _layout
      // User will be automatically redirected to /auth
    } catch (error) {
      console.error('❌ Logout error:', error);
    } finally {
      setIsLoggingOut(false);
    }
  }, [signOut]);

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
        {/* Minimal Header */}
        <View className="pt-16 px-6 pb-4 flex-row justify-between items-center">
          <Logomark width={100} height={20} />
          <View className="flex-row items-center gap-3">
            {currentSlide < totalSlides - 1 && (
              <Pressable onPress={handleSkip}>
                <Text className="text-[14px] font-roobert text-muted-foreground">
                  {t('onboarding.skip')}
                </Text>
              </Pressable>
            )}
            <Pressable 
              onPress={handleLogout}
              disabled={isLoggingOut}
            >
              <Icon 
                as={LogOut} 
                size={18} 
                className={isLoggingOut ? "text-muted-foreground/50" : "text-muted-foreground"} 
              />
            </Pressable>
          </View>
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
            onSuccess={handleComplete}
            t={t}
          />
        </ScrollView>

        {/* Minimal Pagination Dots */}
        <View className="flex-row justify-center gap-1.5 mb-6">
          {Array.from({ length: totalSlides }).map((_, index) => (
            <PaginationDot
              key={index}
              index={index}
              currentIndex={currentSlide}
              scrollX={scrollX}
            />
          ))}
        </View>

        {/* Next Button - Only show on non-billing slides */}
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
  scrollX: SharedValue<number>;
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
      [0.92, 1, 0.92],
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
      <Animated.View style={animatedStyle} className="items-center w-full max-w-sm">
        {/* Minimalist Icon Container */}
        <View className="w-full mb-12 items-center">
          <View
            className="w-20 h-20 rounded-2xl items-center justify-center mb-4"
            style={{
              backgroundColor: colorScheme === 'dark' 
                ? slide.color + '15' 
                : slide.color + '10',
            }}
          >
            <IconComponent
              size={40}
              color={slide.color}
              strokeWidth={1.5}
            />
          </View>
        </View>

        {/* Title - Clean Typography */}
        <Text className="text-[28px] font-roobert-semibold text-foreground text-center mb-3 leading-tight tracking-tight">
          {slide.title}
        </Text>

        {/* Description - Subtle and Readable */}
        <Text className="text-[15px] font-roobert text-muted-foreground text-center leading-relaxed mb-6 opacity-80">
          {slide.description}
        </Text>

        {/* Minimalist Example Tag */}
        {slide.example && (
          <View 
            className="px-4 py-2 rounded-full border"
            style={{
              borderColor: colorScheme === 'dark' 
                ? 'rgba(255, 255, 255, 0.1)' 
                : 'rgba(0, 0, 0, 0.06)',
              backgroundColor: colorScheme === 'dark'
                ? 'rgba(255, 255, 255, 0.03)'
                : 'rgba(0, 0, 0, 0.02)',
            }}
          >
            <Text 
              className="text-[13px] font-roobert text-center text-muted-foreground"
            >
              {slide.example}
            </Text>
          </View>
        )}
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
  scrollX: SharedValue<number>;
}

function PaginationDot({ index, scrollX }: PaginationDotProps) {
  const { colorScheme } = useColorScheme();
  
  const animatedStyle = useAnimatedStyle(() => {
    const inputRange = [
      (index - 1) * SCREEN_WIDTH,
      index * SCREEN_WIDTH,
      (index + 1) * SCREEN_WIDTH,
    ];

    const width = interpolate(
      scrollX.value,
      inputRange,
      [6, 20, 6],
      Extrapolate.CLAMP
    );

    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.25, 1, 0.25],
      Extrapolate.CLAMP
    );

    return {
      width,
      opacity,
    };
  });

  return (
    <Animated.View
      style={[
        animatedStyle,
        {
          backgroundColor: colorScheme === 'dark' 
            ? 'rgba(255, 255, 255, 0.9)' 
            : 'rgba(0, 0, 0, 0.9)',
        }
      ]}
      className="h-1.5 rounded-full"
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
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      style={animatedStyle}
      className="bg-foreground h-12 rounded-xl flex-row items-center justify-center"
    >
      <Text className="text-[15px] font-roobert-medium text-background">
        {isLast ? t('onboarding.getStarted') : t('onboarding.next')}
      </Text>
      <Icon as={ArrowRight} size={18} className="text-background ml-1" />
    </AnimatedPressable>
  );
}

/**
 * Billing Slide Component - Simplified using BillingContent
 */
interface BillingSlideProps {
  index: number;
  scrollX: SharedValue<number>;
  onSuccess: () => void;
  t: (key: string, defaultValue?: string) => string;
}

function BillingSlide({
  index,
  scrollX,
  onSuccess,
  t,
}: BillingSlideProps) {
  const { colorScheme } = useColorScheme();
  const [billingPeriod, setBillingPeriod] = React.useState<BillingPeriod>('yearly_commitment');
  const [planLoadingStates, setPlanLoadingStates] = React.useState<Record<string, boolean>>({});
  const cardScale = useSharedValue(1);
  const cardOpacity = useSharedValue(1);

  const handleSubscribe = async (tierKey: string) => {
    setPlanLoadingStates((prev) => ({ ...prev, [tierKey]: true }));

    try {
      await startPlanCheckout(
        tierKey,
        billingPeriod,
        () => {
          setPlanLoadingStates({});
          onSuccess();
        },
        () => {
          setPlanLoadingStates({});
        }
      );
    } catch (error) {
      console.error('❌ Error starting checkout:', error);
      setPlanLoadingStates({});
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
      [0.92, 1, 0.92],
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

  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cardScale.value }],
    opacity: cardOpacity.value,
  }));

  const tiersToShow = PRICING_TIERS.slice(0, 2);

  return (
    <View
      style={{ width: SCREEN_WIDTH }}
      className="flex-1 px-8 justify-center"
    >
      <Animated.View style={animatedStyle} className="items-center max-w-sm mx-auto w-full">
        <ScrollView showsVerticalScrollIndicator={false} className="w-full">
          {/* Title */}
          <View className="mb-8">
            <Text className="text-[28px] font-roobert-semibold text-foreground text-center mb-2 leading-tight tracking-tight">
              {t('billing.subscription.title', 'Choose Your Plan')}
            </Text>
            <Text className="text-[15px] font-roobert text-muted-foreground text-center opacity-70">
              {t('billing.subtitle', 'Select a plan to get started')}
            </Text>
          </View>

          {/* Period Selector */}
          <BillingPeriodSelector
            selected={billingPeriod}
            onChange={setBillingPeriod}
            t={t}
          />

          {/* Pricing Tiers - Only top 2 for onboarding */}
          <View className="space-y-3">
              {tiersToShow.map((tier) => {
                const displayPrice = getDisplayPrice(tier, billingPeriod);
                const isLoading = planLoadingStates[tier.id] || false;

                return (
                  <PricingTierCard
                    key={tier.id}
                    tier={tier}
                    displayPrice={displayPrice}
                    billingPeriod={billingPeriod}
                    currentSubscription={null}
                    isLoading={isLoading}
                    isFetchingPlan={false}
                    onPlanSelect={(planId) => setPlanLoadingStates((prev) => ({ ...prev, [planId]: true }))}
                    onSubscribe={handleSubscribe}
                    isAuthenticated={false}
                    currentBillingPeriod={null}
                    t={t}
                  />
                );
              })}
            </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

