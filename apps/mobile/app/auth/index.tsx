import * as React from 'react';
import { View, Pressable, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Mail } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useLanguage, useGuestMode } from '@/contexts';
import * as Haptics from 'expo-haptics';
import Animated, { 
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withDelay,
  withTiming,
  Easing,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
import { KortixLogo } from '@/components/ui/KortixLogo';
import { GuestModeConsent } from '@/components/auth/GuestModeConsent';
import { AuthDrawer } from '@/components/auth/AuthDrawer';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';

const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedText = Animated.createAnimatedComponent(Text);


function getRotatingPhrases(t: (key: string) => string) {
  return [
    { text: t('auth.rotatingPhrases.presentations'), color: '' },
    { text: t('auth.rotatingPhrases.writing'), color: '' },
    { text: t('auth.rotatingPhrases.emails'), color: '' },
    { text: t('auth.rotatingPhrases.research'), color: '' },
    { text: t('auth.rotatingPhrases.planning'), color: '' },
    { text: t('auth.rotatingPhrases.studying'), color: '' },
    { text: t('auth.rotatingPhrases.anything'), color: '' },
  ];
}

function RotatingText() {
  const { t } = useLanguage();
  const rotatingPhrases = React.useMemo(() => getRotatingPhrases(t), [t]);
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [currentPhrase, setCurrentPhrase] = React.useState(rotatingPhrases[0]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % rotatingPhrases.length);
    }, 1800);

    return () => clearInterval(interval);
  }, [rotatingPhrases.length]);

  React.useEffect(() => {
    setCurrentPhrase(rotatingPhrases[currentIndex]);
  }, [currentIndex, rotatingPhrases]);

  const chars = currentPhrase.text.split('');

  return (
    <View style={{ height: 40, overflow: 'hidden' }}>
      <View className="flex-row flex-wrap">
        {chars.map((char, index) => (
          <AnimatedChar 
            key={`${currentIndex}-${index}`} 
            char={char} 
            index={index}
            color={currentPhrase.color}
          />
        ))}
      </View>
    </View>
  );
}

function AnimatedChar({ char, index, color }: { char: string; index: number; color: string }) {
  const rotateX = useSharedValue(-90);
  const opacity = useSharedValue(0);

  React.useEffect(() => {
    rotateX.value = -90;
    opacity.value = 0;

    rotateX.value = withDelay(
      index * 40,
      withTiming(0, {
        duration: 600,
        easing: Easing.out(Easing.cubic),
      })
    );

    opacity.value = withDelay(
      index * 40,
      withTiming(1, {
        duration: 400,
        easing: Easing.out(Easing.cubic),
      })
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
          lineHeight: 40,
          letterSpacing: -0.3,
        },
        color ? { color } : undefined,
      ]}
      className="text-foreground"
    >
      {char}
    </AnimatedText>
  );
}

function GoogleLogo() {
  return (
    <Svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <Path
        d="M19.6 10.227c0-.709-.064-1.39-.182-2.045H10v3.868h5.382a4.6 4.6 0 01-1.996 3.018v2.51h3.232c1.891-1.742 2.982-4.305 2.982-7.35z"
        fill="#4285F4"
      />
      <Path
        d="M10 20c2.7 0 4.964-.895 6.618-2.423l-3.232-2.509c-.895.6-2.04.955-3.386.955-2.605 0-4.81-1.76-5.595-4.123H1.064v2.59A9.996 9.996 0 0010 20z"
        fill="#34A853"
      />
      <Path
        d="M4.405 11.9c-.2-.6-.314-1.24-.314-1.9 0-.66.114-1.3.314-1.9V5.51H1.064A9.996 9.996 0 000 10c0 1.614.386 3.14 1.064 4.49l3.34-2.59z"
        fill="#FBBC05"
      />
      <Path
        d="M10 3.977c1.468 0 2.786.505 3.823 1.496l2.868-2.868C14.96.99 12.695 0 10 0 6.09 0 2.71 2.24 1.064 5.51l3.34 2.59C5.19 5.736 7.395 3.977 10 3.977z"
        fill="#EA4335"
      />
    </Svg>
  );
}

export default function AuthScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signInWithOAuth } = useAuth();
  const { hasCompletedOnboarding } = useOnboarding();
  const { enableGuestMode } = useGuestMode();
  const { openAuthDrawer } = useAuthDrawerStore();
  
  const [showGuestConsent, setShowGuestConsent] = React.useState(false);

  const handleNavigateToHome = React.useCallback(() => {
    if (!hasCompletedOnboarding) {
      router.replace('/onboarding');
    } else {
      router.replace('/home');
    }
  }, [hasCompletedOnboarding, router]);

  const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await signInWithOAuth(provider);
    if (result.success) {
      handleNavigateToHome();
    }
  };

  const showEmailAuth = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    openAuthDrawer({
      mode: 'email-auth',
      onSuccess: () => {
        handleNavigateToHome();
      },
    });
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-background">
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <WelcomeView 
            onEmailPress={showEmailAuth}
            onOAuthSignIn={handleOAuthSignIn}
            onGuestModePress={() => {
              console.log('🔵 Guest mode button pressed');
              setShowGuestConsent(true);
              console.log('🔵 showGuestConsent set to true');
            }}
          />
        </ScrollView>

        <GuestModeConsent
          visible={showGuestConsent}
          onAccept={async () => {
            setShowGuestConsent(false);
            await enableGuestMode();
            router.replace('/home');
          }}
          onDecline={() => {
            setShowGuestConsent(false);
            openAuthDrawer({
              mode: 'email-auth',
              onSuccess: () => {
                handleNavigateToHome();
              },
            });
          }}
          onDismiss={() => {
            setShowGuestConsent(false);
          }}
        />

        <AuthDrawer />
      </View>
    </>
  );
}

function WelcomeView({ 
  onEmailPress,
  onOAuthSignIn,
  onGuestModePress 
}: { 
  onEmailPress: () => void;
  onOAuthSignIn: (provider: 'apple' | 'google') => void;
  onGuestModePress: () => void;
}) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <AnimatedView 
      entering={FadeIn.duration(400)}
      className="flex-1 justify-end px-8 py-16"
    >
      <View className="justify-center mb-12">
        <View className="mb-4">
          <KortixLogo variant="logomark" size={72} color={isDark ? 'dark' : 'light'} />
        </View>
        <View className="gap-2">
          <Text className="text-4xl font-roobert-semibold text-foreground tracking-tight leading-tight">
            {t('auth.welcomeTitle')}
          </Text>
          <RotatingText />
        </View>
      </View>
      <View className="w-full gap-3">
        <Button
          variant="default"
          size="lg"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onOAuthSignIn('apple');
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
            onOAuthSignIn('google');
          }}
          className="bg-white border border-[#dadce0]"
        >
          <GoogleLogo />
          <Text className="text-[16px] font-roobert-medium text-[#1f1f1f]">
            {t('auth.continueWithGoogle')}
          </Text>
        </Button>

        <Button
          variant="outline"
          size="lg"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onEmailPress();
          }}
        >
          <Icon as={Mail} size={20} className="text-foreground" />
          <Text className="text-[16px] font-roobert-medium text-foreground">
            {t('auth.continueWithEmail')}
          </Text>
        </Button>

        <Button
          variant="ghost"
          size="lg"
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onGuestModePress();
          }}
          className="bg-transparent"
        >
          <Text className="text-muted-foreground text-[16px] font-roobert">
            {t('auth.browseAsGuest')}
          </Text>
        </Button>
      </View>
    </AnimatedView>
  );
}

