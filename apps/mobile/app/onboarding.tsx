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
  interpolate,
  Extrapolate,
  SharedValue,
} from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { useAuthContext } from '@/contexts/AuthContext';
import { useAgent } from '@/contexts/AgentContext';
import { useBillingContext } from '@/contexts/BillingContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAccountSetup } from '@/hooks/useAccountSetup';
import { useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/lib/agents';

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
export default function OnboardingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signOut, session } = useAuthContext();
  const { loadAgents } = useAgent();
  const { refetchAll: refetchBilling } = useBillingContext();
  const { markSetupComplete } = useAccountSetup();
  const queryClient = useQueryClient();
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const scrollX = useSharedValue(0);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

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

  const totalSlides = slides.length;

  const handleComplete = React.useCallback(async () => {
    try {
      const userId = session?.user?.id || 'anonymous';
      const onboardingKey = `${ONBOARDING_KEY_PREFIX}${userId}`;
      await AsyncStorage.setItem(onboardingKey, 'true');
      
      await markSetupComplete();
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      console.log('🔄 Refetching billing, credits, and agents after onboarding completion...');
      
      refetchBilling();
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      await loadAgents();
      
      console.log(`✅ Onboarding completed for user: ${userId}`);
      router.replace('/home');
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      router.replace('/home');
    }
  }, [loadAgents, refetchBilling, queryClient, router, session?.user?.id, markSetupComplete]);

  const handleLogout = React.useCallback(async () => {
    try {
      setIsLoggingOut(true);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      
      console.log('🔓 Logging out from onboarding...');
      await signOut();
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
    } else {
      handleComplete();
    }
  };

  const handleSkip = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    handleComplete();
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
        </ScrollView>
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
        <View className="px-6 pb-8">
          <ContinueButton
            onPress={handleNext}
            isLast={currentSlide === totalSlides - 1}
            t={t}
          />
        </View>
      </View>
    </>
  );
}


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

        <Text className="text-[28px] font-roobert-semibold text-foreground text-center mb-3 leading-tight tracking-tight">
          {slide.title}
        </Text>

        <Text className="text-[15px] font-roobert text-muted-foreground text-center leading-relaxed mb-6 opacity-80">
          {slide.description}
        </Text>

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
