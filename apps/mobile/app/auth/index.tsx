import * as React from 'react';
import { View, Platform, BackHandler, TouchableOpacity, Pressable } from 'react-native';
import { useRouter, Stack, useFocusEffect } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui';
import { Mail, TextAlignStart } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage, useAuthContext } from '@/contexts';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
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
import { LiquidGlass } from '@/components/ui';
import { ProgressiveBlur } from '@/components/ui/progressive-blur';
import { log } from '@/lib/logger';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedText = Animated.createAnimatedComponent(Text);
const SCREEN_WIDTH = Dimensions.get('window').width;

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
    <View style={{ height: 24, overflow: 'hidden', zIndex: 20 }}>
      <View className="flex-row flex-wrap" style={{ zIndex: 20 }}>
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
      index * 20,
      withTiming(0, { duration: 400, easing: Easing.out(Easing.cubic) })
    );

    opacity.value = withDelay(
      index * 20,
      withTiming(1, { duration: 300, easing: Easing.out(Easing.cubic) })
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
          fontFamily: 'Roobert-Medium', 
          fontSize: 18, 
          lineHeight: 24,
          letterSpacing: 0,
          color: 'rgba(255, 255, 255, 0.7)',
          zIndex: 20,
        },
      ]}
    >
      {char}
    </AnimatedText>
  );
}


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

export default function AuthScreen() {
  const router = useRouter();
  const { signInWithOAuth } = useAuth();
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const emailDrawerRef = React.useRef<EmailAuthDrawerRef>(null);

  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS === 'android') {
        const onBackPress = () => {
          if (isAuthenticated) {
            router.replace('/(app)');
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
      log.log('🔄 Auth page: user authenticated, closing drawer and redirecting to /home');
      emailDrawerRef.current?.close();
      router.replace('/(app)');
    }
  }, [isAuthenticated, router]);

  const handleOAuth = React.useCallback(async (provider: 'apple' | 'google') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await signInWithOAuth(provider);
    if (result && typeof result === 'object' && 'success' in result && result.success) {
      router.replace('/');
    }
  }, [signInWithOAuth, router]);

  const handleEmail = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    emailDrawerRef.current?.open();
  }, []);

  if (isAuthenticated && !authLoading) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
        <View className="flex-1 bg-background items-center justify-center">
          <KortixLoader size="xlarge" />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <View style={{ flex: 1 }}>
        <ProgressiveBlur />
        <View className="flex-1" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 }}>
          <WelcomeContent onOAuth={handleOAuth} onEmail={handleEmail} />
          <EmailAuthDrawer ref={emailDrawerRef} />
        </View>
      </View>
    </>
  );
}

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

  const renderButton = (
    onPress: () => void,
    icon: React.ReactNode,
    label: string,
    isPrimary = false
  ) => {
    const buttonContent = (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          height: 56,
        }}
      >
        {icon}
        <Text
          style={{
            fontSize: 16,
            fontFamily: 'Roobert-Medium',
            color: '#FFFFFF',
          }}
        >
          {label}
        </Text>
      </View>
    );

    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.8}
        style={{ zIndex: 30 }}
      >
        <LiquidGlass
          tintColor="rgba(255, 255, 255, 0.08)"
          borderRadius={28}
          borderWidth={0.5}
          borderColor="rgba(255, 255, 255, 0.2)"
          style={{
            overflow: 'hidden',
            zIndex: 30,
          }}
        >
          {buttonContent}
        </LiquidGlass>
      </TouchableOpacity>
    );
  };


  return (
    <View 
      className="flex-1 justify-between"
      style={{
        paddingTop,
        paddingBottom,
        paddingHorizontal: SPACING.horizontal,
      }}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <AnimatedView 
          entering={FadeIn.duration(600)}
          style={{ marginBottom: SPACING.contentToButtons, zIndex: 20 }}
        >
          <View style={{ marginBottom: 12 }}  >
            <KortixLogo variant="logomark" size={24} color="dark" />
          </View>
          <Text 
            style={{ 
              fontFamily: 'Roobert-Regular',
              fontSize: 18,
              lineHeight: 26,
              letterSpacing: 0.1,
              marginBottom: 0,
              color: 'rgba(255, 255, 255, 0.85)',
              zIndex: 20,
            }}
          >
            {t('auth.welcomeSubtitle')}
          </Text>
        </AnimatedView>

        {/* Auth Buttons */}
        <AnimatedView 
          entering={FadeInDown.duration(500).delay(200)}
          style={{ gap: SPACING.betweenButtons, zIndex: 20 }}
        >
          {Platform.OS === 'ios' && renderButton(
            () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onOAuth('apple');
            },
            <FontAwesome5 name="apple" size={20} color="#FFFFFF" />,
            t('auth.continueWithApple'),
            true
          )}

          {renderButton(
            () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onOAuth('google');
            },
            <GoogleLogo />,
            t('auth.continueWithGoogle')
          )}

          {renderButton(
            () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onEmail();
            },
            <Icon as={Mail} size={20} className="text-white" />,
            t('auth.continueWithEmail')
          )}
        </AnimatedView>
      </View>
    </View>
  );
}
