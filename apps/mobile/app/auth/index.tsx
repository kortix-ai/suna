import * as React from 'react';
import { View, Platform, BackHandler } from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useLanguage, useAuthContext } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, { 
  FadeIn,
  FadeInDown,
  useAnimatedStyle, 
  useSharedValue, 
  withDelay,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Dimensions, Animated as RNAnimated } from 'react-native';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { EmailAuthDrawer, type EmailAuthDrawerRef } from '@/components/auth';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedText = Animated.createAnimatedComponent(Text);
const SCREEN_WIDTH = Dimensions.get('window').width;

// ============================================================================
// Constants
// ============================================================================

const SPACING = {
  // Screen padding
  horizontal: 24,
  bottomMin: 48,
  topMin: 24,
  
  // Content spacing
  logoToTitle: 16,
  titleToSubtitle: 8,
  contentToButtons: 40,
  betweenButtons: 12,
} as const;

// ============================================================================
// Rotating Text Animation
// ============================================================================

function getRotatingPhrases(t: (key: string) => string) {
  return [
    t('auth.rotatingPhrases.presentations'),
    t('auth.rotatingPhrases.writing'),
    t('auth.rotatingPhrases.emails'),
    t('auth.rotatingPhrases.research'),
    t('auth.rotatingPhrases.planning'),
    t('auth.rotatingPhrases.studying'),
    t('auth.rotatingPhrases.anything'),
  ];
}

function RotatingText() {
  const { t } = useLanguage();
  const phrases = React.useMemo(() => getRotatingPhrases(t), [t]);
  const [currentIndex, setCurrentIndex] = React.useState(0);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % phrases.length);
    }, 1800);
    return () => clearInterval(interval);
  }, [phrases.length]);

  const chars = phrases[currentIndex].split('');

  return (
    <View style={{ height: 44, overflow: 'hidden' }}>
      <View className="flex-row flex-wrap">
        {chars.map((char, index) => (
          <AnimatedChar 
            key={`${currentIndex}-${index}`} 
            char={char} 
            index={index}
          />
        ))}
      </View>
    </View>
  );
}

function AnimatedChar({ char, index }: { char: string; index: number }) {
  const rotateX = useSharedValue(-90);
  const opacity = useSharedValue(0);

  React.useEffect(() => {
    rotateX.value = -90;
    opacity.value = 0;

    rotateX.value = withDelay(
      index * 35,
      withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) })
    );

    opacity.value = withDelay(
      index * 35,
      withTiming(1, { duration: 350, easing: Easing.out(Easing.cubic) })
    );
  }, [index]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { perspective: 400 },
      { rotateX: `${rotateX.value}deg` },
    ],
  }));

  return (
    <AnimatedText
      style={[
        animatedStyle, 
        { 
          fontFamily: 'Roobert-SemiBold', 
          fontSize: 36, 
          lineHeight: 44,
          letterSpacing: -0.5,
        },
      ]}
      className="text-foreground"
    >
      {char}
    </AnimatedText>
  );
}

// ============================================================================
// Background Logo
// ============================================================================

function AuthBackgroundLogo() {
  const { colorScheme } = useColorScheme();
  const fadeAnim = React.useRef(new RNAnimated.Value(0)).current;

  React.useEffect(() => {
    RNAnimated.timing(fadeAnim, {
      toValue: 1.0,
      duration: 3000, 
      useNativeDriver: true,
    }).start();
  }, []);

  const leftOffset = (SCREEN_WIDTH - 393) / 2;
  const SymbolComponent = colorScheme === 'dark' ? KortixSymbolWhite : KortixSymbolBlack;

  return (
    <RNAnimated.View
      style={{
        position: 'absolute',
        top: 20,
        left: -80 + leftOffset,
        width: 554,
        height: 462,
        opacity: fadeAnim,
      }}
    >
      <SymbolComponent width={554} height={462} />
    </RNAnimated.View>
  );
}

// ============================================================================
// Google Logo
// ============================================================================

function GoogleLogo() {
  return (
    <Svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <Path d="M19.6 10.227c0-.709-.064-1.39-.182-2.045H10v3.868h5.382a4.6 4.6 0 01-1.996 3.018v2.51h3.232c1.891-1.742 2.982-4.305 2.982-7.35z" fill="#4285F4" />
      <Path d="M10 20c2.7 0 4.964-.895 6.618-2.423l-3.232-2.509c-.895.6-2.04.955-3.386.955-2.605 0-4.81-1.76-5.595-4.123H1.064v2.59A9.996 9.996 0 0010 20z" fill="#34A853" />
      <Path d="M4.405 11.9c-.2-.6-.314-1.24-.314-1.9 0-.66.114-1.3.314-1.9V5.51H1.064A9.996 9.996 0 000 10c0 1.614.386 3.14 1.064 4.49l3.34-2.59z" fill="#FBBC05" />
      <Path d="M10 3.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C14.96.99 12.695 0 10 0 6.09 0 2.71 2.24 1.064 5.51l3.34 2.59C5.19 5.736 7.395 3.977 10 3.977z" fill="#EA4335" />
    </Svg>
  );
}

// ============================================================================
// Auth Screen
// ============================================================================

export default function AuthScreen() {
  const router = useRouter();
  const { signInWithOAuth } = useAuth();
  const { isAuthenticated } = useAuthContext();
  const emailDrawerRef = React.useRef<EmailAuthDrawerRef>(null);

  // Prevent back navigation if authenticated
  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS === 'android') {
        const onBackPress = () => {
          if (isAuthenticated) {
            router.replace('/');
            return true;
          }
          return false;
        };
        const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
        return () => sub.remove();
      }
    }, [isAuthenticated, router])
  );

  // Redirect if already authenticated AND close any open drawer
  React.useEffect(() => {
    if (isAuthenticated) {
      console.log('🔄 Auth page: user authenticated, closing drawer and redirecting');
      emailDrawerRef.current?.close();
      router.replace('/');
    }
  }, [isAuthenticated, router]);

  const handleOAuth = React.useCallback(async (provider: 'apple' | 'google') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await signInWithOAuth(provider);
    if (result.success) router.replace('/');
  }, [signInWithOAuth, router]);

  const handleEmail = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    emailDrawerRef.current?.open();
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View className="flex-1 bg-background">
        <View className="absolute inset-0" pointerEvents="none">
          <AuthBackgroundLogo />
        </View>
        <WelcomeContent onOAuth={handleOAuth} onEmail={handleEmail} />
        <EmailAuthDrawer ref={emailDrawerRef} />
      </View>
    </>
  );
}

// ============================================================================
// Welcome Content
// ============================================================================

interface WelcomeContentProps {
  onOAuth: (provider: 'apple' | 'google') => void;
  onEmail: () => void;
}

function WelcomeContent({ onOAuth, onEmail }: WelcomeContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const isDark = colorScheme === 'dark';

  const paddingBottom = Math.max(insets.bottom + 16, SPACING.bottomMin);
  const paddingTop = Math.max(insets.top, SPACING.topMin);

  return (
    <View 
      className="flex-1 justify-end"
      style={{
        paddingTop,
        paddingBottom,
        paddingHorizontal: SPACING.horizontal,
      }}
    >
      {/* Branding Section */}
      <AnimatedView 
        entering={FadeIn.duration(600)}
        style={{ marginBottom: SPACING.contentToButtons }}
    >
        {/* Logo */}
        <View style={{ marginBottom: SPACING.logoToTitle }}>
          <KortixLogo variant="logomark" size={100} color={isDark ? 'dark' : 'light'} />
        </View>
        
        {/* Title */}
        <Text 
          className="text-foreground tracking-tight"
          style={{ 
            fontFamily: 'Roobert-SemiBold',
            fontSize: 36,
            lineHeight: 44,
            letterSpacing: -0.5,
            marginBottom: SPACING.titleToSubtitle,
          }}
        >
            {t('auth.welcomeTitle')}
          </Text>
        
        {/* Rotating Subtitle */}
          <RotatingText />
      </AnimatedView>

      {/* Auth Buttons */}
      <AnimatedView 
        entering={FadeInDown.duration(500).delay(200)}
        style={{ gap: SPACING.betweenButtons }}
      >
        <Button
          variant="default"
          size="lg"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOAuth('apple');
            }}
          className="bg-[#000000]"
          >
            <FontAwesome5 name="apple" size={20} color="white" />
          <Text className="text-[16px] font-roobert-medium text-white">
              {t('auth.continueWithApple')}
            </Text>
        </Button>

        <Button
          variant="outline"
          size="lg"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOAuth('google');
            }}
          className="border border-[#dadce0]"
          style={{ backgroundColor: '#ffffff' }}
          >
            <GoogleLogo />
          <Text className="text-[16px] font-roobert-medium" style={{ color: '#1f1f1f' }}>
              {t('auth.continueWithGoogle')}
            </Text>
        </Button>

        <Button
          variant="outline"
          size="lg"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onEmail();
          }}
        >
            <Icon as={Mail} size={20} className="text-foreground" />
          <Text className="text-[16px] font-roobert-medium text-foreground">
              {t('auth.continueWithEmail')}
            </Text>
        </Button>
      </AnimatedView>
      </View>
  );
}
