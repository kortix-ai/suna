import * as React from 'react';
import { View, Pressable, Dimensions, ScrollView, TouchableOpacity } from 'react-native';
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
import { KortixLogo } from '@/components/ui/KortixLogo';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  interpolate,
  Extrapolate,
  SharedValue,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { useAuthContext } from '@/contexts/AuthContext';
import { useAgent } from '@/contexts/AgentContext';
import { useBillingContext } from '@/contexts/BillingContext';
import { useAccountSetup } from '@/hooks/useAccountSetup';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useQueryClient } from '@tanstack/react-query';
import { agentKeys } from '@/lib/agents';
import { modelKeys } from '@/lib/models';
import { BackgroundLogo } from '@/components/home';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

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
  const { signOut } = useAuthContext();
  const { loadAgents } = useAgent();
  const { refetchAll: refetchBilling } = useBillingContext();
  const { markSetupComplete } = useAccountSetup();
  const { markAsCompleted } = useOnboarding();
  const queryClient = useQueryClient();
  const [currentSlide, setCurrentSlide] = React.useState(0);
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const scrollX = useSharedValue(0);
  const scale2 = useSharedValue(1);
  const scrollViewRef = React.useRef<ScrollView>(null);

  const animatedStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: scale2.value }],
  }));

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
      color: '#14B8A6',
      gradient: ['#10B981', '#10B981'],
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
      await markAsCompleted();
      await markSetupComplete();

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      refetchBilling();
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      queryClient.invalidateQueries({ queryKey: modelKeys.available() });
      await loadAgents();
      
      console.log('✅ Onboarding completed successfully! Navigating to home...');
      router.replace('/home');
    } catch (error) {
      console.error('❌ Failed to complete onboarding:', error);
      router.replace('/home');
    }
  }, [loadAgents, refetchBilling, queryClient, router, markSetupComplete, markAsCompleted]);

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
        <View className='absolute inset-0' pointerEvents="none">
          <BackgroundLogo/>
        </View>
        <View className="pt-16 px-8 pb-4 flex-row justify-between items-center">
          <KortixLogo variant="logomark" size={60} color={colorScheme === 'dark' ? 'dark' : 'light'} />
          <View className="flex-row items-center gap-4">
            <TouchableOpacity 
              onPress={handleLogout}
              disabled={isLoggingOut}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon 
                as={LogOut} 
                size={20} 
                className={isLoggingOut ? "text-muted-foreground/50" : "text-muted-foreground"} 
              />
            </TouchableOpacity>
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
        
        <View className="px-8 pb-8">
          <View className="flex-row gap-2 mb-6">
            {Array.from({ length: totalSlides }).map((_, index) => (
              <PaginationDot
                key={index}
                index={index}
                currentIndex={currentSlide}
                scrollX={scrollX}
              />
            ))}
          </View>
          
          <ContinueButton
            onPress={handleNext}
            isLast={currentSlide === totalSlides - 1}
            t={t}
          />
           {currentSlide < totalSlides - 1 && (
             <AnimatedPressable 
               onPress={handleComplete}
               onPressIn={() => {
                 scale2.value = withSpring(0.96, { damping: 15, stiffness: 400 });
               }}
               onPressOut={() => {
                 scale2.value = withSpring(1, { damping: 15, stiffness: 400 });
               }}
               hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} 
               style={[animatedStyle2, { 
                 backgroundColor: 'transparent',
                 borderWidth: 1,
                 borderColor: colorScheme === 'dark' ? '#454444' : '#c2c2c2',
                 height: 56,
                 borderRadius: 28,
                 justifyContent: 'center',
                 alignItems: 'center',
                 marginTop: 10,
               }]}
             >
               <Text className='text-foreground text-[16px] font-roobert-medium'>
                 {t('onboarding.skip')}
               </Text>
             </AnimatedPressable>
           )}
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

    const opacity = interpolate(
      scrollX.value,
      inputRange,
      [0.3, 1, 0.3],
      Extrapolate.CLAMP
    );

    return {
      opacity,
    };
  });

  const IconComponent = slide.icon;
  const isDark = colorScheme === 'dark';

  return (
    <View
      style={{ width: SCREEN_WIDTH }}
      className="flex-1 justify-end px-8 pb-16"
    >
      <AnimatedView 
        entering={FadeIn.duration(400)}
        style={animatedStyle} 
        className="w-full"
      >
        <View className="mb-2">
          <View
            className="w-24 h-24 rounded-3xl items-center justify-center mb-6"
            style={{
              backgroundColor: isDark 
                ? slide.color
                : slide.color,
            }}
          >
            <IconComponent
              size={40}
              color='white'
              strokeWidth={2}
            />
          </View>
        </View>

        <Text className="text-[36px] font-roobert-semibold text-foreground mb-4 leading-tight tracking-tight">
          {slide.title}
        </Text>

        <Text className="text-[16px] font-roobert text-muted-foreground leading-relaxed mb-6">
          {slide.description}
        </Text>

        {slide.example && (
          <View 
            className="px-5 py-3 rounded-full self-start"
            style={{
              backgroundColor: isDark
                ? 'rgba(255, 255, 255, 0.05)'
                : 'rgba(0, 0, 0, 0.03)',
            }}
          >
            <Text 
              className="text-[14px] font-roobert text-muted-foreground"
            >
              {slide.example}
            </Text>
          </View>
        )}
      </AnimatedView>
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

  const isDark = colorScheme === 'dark';

  return (
    <AnimatedView
      style={[
        animatedStyle,
        {
          backgroundColor: isDark 
            ? '#FFFFFF' 
            : '#000000',
          height: 8,
          borderRadius: 4,
        }
      ]}
    />
  );
}

interface ContinueButtonProps {
  onPress: () => void;
  isLast: boolean;
  t: (key: string) => string;
}

function ContinueButton({ onPress, isLast, t }: ContinueButtonProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const isDark = colorScheme === 'dark';

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      style={[animatedStyle, { 
        backgroundColor: isDark ? '#FFFFFF' : '#000000',
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'row',
      }]}
    >
      <Text style={{ 
        color: isDark ? '#000000' : '#FFFFFF',
        fontSize: 16,
        fontFamily: 'Roobert-Medium',
        marginRight: 4,
      }}>
        {isLast ? t('onboarding.getStarted') : t('onboarding.next')}
      </Text>
      <Icon 
        as={ArrowRight} 
        size={20} 
        color={isDark ? '#000000' : '#FFFFFF'} 
        strokeWidth={2.5}
      />
    </AnimatedPressable>
  );
}
