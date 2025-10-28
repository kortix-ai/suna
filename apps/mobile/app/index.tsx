import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import Animated, {
  useAnimatedStyle,
  withRepeat,
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
 * - Authenticated + Not completed onboarding → Onboarding
 * - Authenticated + Completed onboarding → App
 * 
 * Note: Onboarding is shown every time user logs in (per user, per device)
 * If user has active billing, onboarding auto-completes after showing features
 */
export default function SplashScreen() {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const { isAuthenticated, isLoading: authLoading, session } = useAuthContext();
  const { hasCompletedOnboarding, isLoading: onboardingLoading } = useOnboarding();
  const [isReady, setIsReady] = React.useState(false);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  // Animated values for logo
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.8);

  React.useEffect(() => {
    // Animate logo in
    opacity.value = withTiming(1, { duration: 600, easing: Easing.out(Easing.ease) });
    scale.value = withSequence(
      withTiming(1.05, { duration: 400, easing: Easing.out(Easing.ease) }),
      withTiming(1, { duration: 200, easing: Easing.inOut(Easing.ease) })
    );
  }, []);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  // Route user once we have all the info
  React.useEffect(() => {
    if (!authLoading && !onboardingLoading) {
      // Small delay for smooth transition
      const timeoutId = setTimeout(() => {
        if (!isAuthenticated) {
          console.log('🔐 User not authenticated, routing to sign in');
          router.replace('/auth');
        } else if (!hasCompletedOnboarding) {
          console.log('👋 User needs onboarding, routing to onboarding');
          router.replace('/onboarding');
        } else {
          console.log('✅ User authenticated and onboarded, routing to app');
          router.replace('/home');
        }
        setIsReady(true);
      }, 300); // Reduced delay for faster navigation

      return () => clearTimeout(timeoutId);
    }
  }, [authLoading, onboardingLoading, isAuthenticated, hasCompletedOnboarding, router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background items-center justify-center">
        <Animated.View style={logoStyle} className="items-center mb-8">
          <Logomark width={240} height={48} />
        </Animated.View>
        
        {!isReady && (
          <View className="mt-8">
            <ActivityIndicator size="large" color="hsl(var(--primary))" />
          </View>
        )}
      </View>
    </>
  );
}

