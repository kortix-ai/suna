import * as React from 'react';
import { View, Pressable, Dimensions, ScrollView } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowRight, MessageSquare, Zap, Shield, Sparkles } from 'lucide-react-native';
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
 * Welcome flow for first-time users after authentication
 * Shows key features and benefits before entering the app
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const scrollX = useSharedValue(0);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  const slides: OnboardingSlide[] = [
    {
      id: '1',
      icon: MessageSquare,
      title: t('onboarding.slide1.title'),
      description: t('onboarding.slide1.description'),
      color: 'hsl(var(--primary))',
    },
    {
      id: '2',
      icon: Zap,
      title: t('onboarding.slide2.title'),
      description: t('onboarding.slide2.description'),
      color: '#F59E0B',
    },
    {
      id: '3',
      icon: Shield,
      title: t('onboarding.slide3.title'),
      description: t('onboarding.slide3.description'),
      color: '#10B981',
    },
    {
      id: '4',
      icon: Sparkles,
      title: t('onboarding.slide4.title'),
      description: t('onboarding.slide4.description'),
      color: '#8B5CF6',
    },
  ];

  const handleComplete = async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/home');
    } catch (error) {
      console.error('Failed to save onboarding status:', error);
      router.replace('/home');
    }
  };

  const handleNext = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (currentSlide < slides.length - 1) {
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
        {/* Header with Skip */}
        <View className="pt-16 px-6 pb-4 flex-row justify-between items-center">
          <Logomark width={120} height={24} />
          {currentSlide < slides.length - 1 && (
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
        </ScrollView>

        {/* Pagination Dots */}
        <View className="flex-row justify-center gap-2 mb-6">
          {slides.map((_, index) => (
            <PaginationDot
              key={index}
              index={index}
              currentIndex={currentSlide}
              scrollX={scrollX}
            />
          ))}
        </View>

        {/* Next/Get Started Button */}
        <View className="px-6 pb-8">
          <ContinueButton
            onPress={handleNext}
            isLast={currentSlide === slides.length - 1}
            t={t}
          />
        </View>
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

