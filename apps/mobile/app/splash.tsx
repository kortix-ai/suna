import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, Stack, type Href } from 'expo-router';
import { useColorScheme } from 'nativewind';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';
import Animated, {
  useAnimatedStyle,
  withTiming,
  useSharedValue,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { useAuthContext } from '@/contexts';
import { useOnboarding } from '@/hooks/useOnboarding';

/**
 * Splash Screen
 * 
 * Shown while checking authentication and onboarding status
 * Routes user to appropriate screen based on state:
 * - Not authenticated → Sign In
 * - Authenticated + No onboarding → Onboarding
 * - Authenticated + Has onboarding → App
 */
export default function SplashScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();
  const [isReady, setIsReady] = React.useState(false);

  const KortixSymbol = colorScheme === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

  // Animated values for symbol
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.9);

  React.useEffect(() => {
    // Animate symbol in with smooth fade and scale
    opacity.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.ease) });
    scale.value = withSequence(
      withTiming(1.1, { duration: 350, easing: Easing.out(Easing.ease) }),
      withTiming(1, { duration: 150, easing: Easing.inOut(Easing.ease) })
    );
  }, []);

  const symbolStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  // Route user once we have all the info
  React.useEffect(() => {
    if (!authLoading && !onboardingLoading) {
      // Small delay for smooth transition
      setTimeout(() => {
        if (!isAuthenticated) {
          console.log('🔐 User not authenticated, routing to sign in');
          router.replace('/auth/sign-in' as Href);
        } else if (!hasCompletedOnboarding) {
          console.log('👋 User needs onboarding, routing to onboarding');
          router.replace('/onboarding' as Href);
        } else {
          console.log('✅ User authenticated and onboarded, routing to app');
          router.replace('/' as Href);
        }
        setIsReady(true);
      }, 800); // Minimum splash display time
    }
  }, [authLoading, onboardingLoading, isAuthenticated, hasCompletedOnboarding, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <Animated.View style={symbolStyle} className="items-center">
          <KortixSymbol width={80} height={80} />
        </Animated.View>
        
        {!isReady && (
          <View className="mt-12">
            <ActivityIndicator size="large" color="hsl(var(--primary))" />
          </View>
        )}
      </View>
    </>
  );
}

