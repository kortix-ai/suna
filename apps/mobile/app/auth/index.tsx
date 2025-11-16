import * as React from 'react';
import { View, Pressable, TextInput, KeyboardAvoidingView, Platform, ScrollView, Keyboard, TouchableOpacity } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Eye, EyeOff, Check, MailCheck, ArrowLeft, Mail } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useLanguage } from '@/contexts';
import KortixSymbolBlack from '@/assets/brand/kortix-symbol-scale-effect-black.svg';
import KortixSymbolWhite from '@/assets/brand/kortix-symbol-scale-effect-white.svg';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { openInbox } from 'react-native-email-link';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
  withTiming,
  withDelay,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { BackgroundLogo } from '@/components/home';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedText = Animated.createAnimatedComponent(Text);

type AuthView = 'welcome' | 'sign-in' | 'sign-up';

function getRotatingPhrases(t: (key: string) => string) {
  return [
    { text: t('auth.rotatingPhrases.presentations'), color: '' },
    { text: t('auth.rotatingPhrases.writing'), color: '' },
    { text: t('auth.rotatingPhrases.emails'), color: '' },
    { text: t('auth.rotatingPhrases.research'), color: '' },
    { text: t('auth.rotatingPhrases.planning'), color: '' },
    { text: t('auth.rotatingPhrases.studying'), color: '' },
    { text: t('auth.rotatingPhrases.anything'), color: '#3B82F6' },
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
    <View style={{ height: 48, overflow: 'hidden' }}>
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
          fontSize: 40, 
          lineHeight: 48,
        },
        color ? { color } : undefined,
      ]}
      className="text-foreground"
    >
      {char}
    </AnimatedText>
  );
}

export default function AuthScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signIn, signUp, signInWithOAuth, isLoading } = useAuth();
  const { hasCompletedOnboarding } = useOnboarding();
  
  const [currentView, setCurrentView] = React.useState<AuthView>('welcome');
  const [showEmailConfirmation, setShowEmailConfirmation] = React.useState(false);
  const [registrationEmail, setRegistrationEmail] = React.useState('');
  
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
  
  const emailInputRef = React.useRef<TextInput>(null);
  const passwordInputRef = React.useRef<TextInput>(null);
  const confirmPasswordInputRef = React.useRef<TextInput>(null);

  const handleNavigateToHome = React.useCallback(() => {
    if (!hasCompletedOnboarding) {
      router.replace('/onboarding');
    } else {
      router.replace('/home');
    }
  }, [hasCompletedOnboarding, router]);

  const handleOpenTerms = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=terms', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
    });
  };

  const handleOpenPrivacy = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=privacy', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
    });
  };

  const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await signInWithOAuth(provider);
    if (result.success) {
      handleNavigateToHome();
    } else {
      setError(result.error?.message || t('auth.signInFailed'));
    }
  };

  const handleSignIn = async () => {
    if (!email || !password) {
      setError(t('auth.validationErrors.emailPasswordRequired'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const result = await signIn({ email, password });

    if (result.success) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleNavigateToHome();
    } else {
      setError(result.error?.message || t('auth.signInFailed'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleSignUp = async () => {
    if (!email || !password) {
      setError(t('auth.validationErrors.emailPasswordRequired'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    if (password !== confirmPassword) {
      setError(t('auth.validationErrors.passwordsNoMatch'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    if (password.length < 8) {
      setError(t('auth.validationErrors.passwordTooShort'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const result = await signUp({ email, password });

    if (result.success) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setRegistrationEmail(email);
      setShowEmailConfirmation(true);
    } else {
      setError(result.error?.message || t('auth.signUpFailed'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const showSignIn = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-in');
    setError('');
  };

  const showSignUp = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-up');
    setError('');
  };

  const showWelcome = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('welcome');
    setError('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setAcceptedTerms(false);
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
          {currentView === 'welcome' && (
            <WelcomeView onSignUp={showSignUp} onSignIn={showSignIn} />
          )}
        </ScrollView>

        <AnimatedPageWrapper visible={currentView === 'sign-in'} onClose={showWelcome}>
          <SignInView
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            error={error}
            isLoading={isLoading}
            onSubmit={handleSignIn}
            onBack={showWelcome}
            onSignUp={showSignUp}
            onOAuthSignIn={handleOAuthSignIn}
            emailInputRef={emailInputRef}
            passwordInputRef={passwordInputRef}
          />
        </AnimatedPageWrapper>

        <AnimatedPageWrapper visible={currentView === 'sign-up'} onClose={showWelcome}>
          <SignUpView
            email={email}
            setEmail={setEmail}
            password={password}
            setPassword={setPassword}
            confirmPassword={confirmPassword}
            setConfirmPassword={setConfirmPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            showConfirmPassword={showConfirmPassword}
            setShowConfirmPassword={setShowConfirmPassword}
            acceptedTerms={acceptedTerms}
            setAcceptedTerms={setAcceptedTerms}
            error={error}
            isLoading={isLoading}
            onSubmit={handleSignUp}
            onBack={showWelcome}
            onSignIn={showSignIn}
            onOAuthSignIn={handleOAuthSignIn}
            onOpenTerms={handleOpenTerms}
            onOpenPrivacy={handleOpenPrivacy}
            emailInputRef={emailInputRef}
            passwordInputRef={passwordInputRef}
            confirmPasswordInputRef={confirmPasswordInputRef}
          />
        </AnimatedPageWrapper>

        <AnimatedPageWrapper 
          visible={showEmailConfirmation} 
          onClose={() => {
            setShowEmailConfirmation(false);
            showWelcome();
          }}
        >
          <EmailConfirmationView
            email={registrationEmail}
            onBack={() => {
              setShowEmailConfirmation(false);
              showWelcome();
            }}
          />
        </AnimatedPageWrapper>
      </View>
    </>
  );
}

function WelcomeView({ onSignUp, onSignIn }: { onSignUp: () => void; onSignIn: () => void }) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const scale1 = useSharedValue(1);
  const scale2 = useSharedValue(1);
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);

  const animatedStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: scale1.value }],
  }));

  const animatedStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: scale2.value }],
  }));

  const isDark = colorScheme === 'dark';
  const SymbolComponent = isDark ? KortixSymbolWhite : KortixSymbolBlack;

  const handleOpenTerms = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=terms', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
    });
  };

  const handleOpenPrivacy = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=privacy', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
    });
  };

  return (
    <AnimatedView 
      entering={FadeIn.duration(400)}
      className="flex-1 justify-end px-8 py-16"
    >
      <View className='absolute inset-0' pointerEvents="none">
        <BackgroundLogo/>
      </View>
      <View className="justify-center mb-10">
        <View className="-mb-4">
          <KortixLogo variant="logomark" size={80} color={isDark ? 'dark' : 'light'} />
        </View>
        <View className="mb-6">
          <Text className="text-3xl font-roobert-semibold text-foreground leading-tight">
            {t('auth.welcomeTitle')}
          </Text>
          <RotatingText />
        </View>
      </View>
      <View className="w-full gap-4">
        <View className="flex-row items-start mb-2">
          <TouchableOpacity
            onPress={() => {
              setAcceptedTerms(!acceptedTerms);
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            className="mr-3 mt-0.5"
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: acceptedTerms ? (isDark ? '#FFFFFF' : '#000000') : isDark ? '#454444' : '#c2c2c2',
                backgroundColor: acceptedTerms ? (isDark ? '#FFFFFF' : '#000000') : 'transparent',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {acceptedTerms && (
                <Icon as={Check} size={16} color={isDark ? '#000000' : '#FFFFFF'} />
              )}
            </View>
          </TouchableOpacity>

          <View className="flex-1 flex-row flex-wrap">
            <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
              {t('auth.agreeTerms')}{' '}
            </Text>
            <TouchableOpacity onPress={handleOpenTerms}>
              <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
                {t('auth.userTerms')}
              </Text>
            </TouchableOpacity>
            <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
              {' '}{t('auth.acknowledgePrivacy')}{' '}
            </Text>
            <TouchableOpacity onPress={handleOpenPrivacy}>
              <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
                {t('auth.privacyNotice')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <AnimatedPressable
          onPress={() => {
            if (!acceptedTerms) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              return;
            }
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onSignUp();
          }}
          onPressIn={() => {
            if (acceptedTerms) {
              scale1.value = withSpring(0.96, { damping: 15, stiffness: 400 });
            }
          }}
          onPressOut={() => {
            scale1.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[animatedStyle1, { 
            backgroundColor: acceptedTerms ? (isDark ? '#FFFFFF' : '#000000') : '#888888',
            height: 56,
            borderRadius: 28,
            justifyContent: 'center',
            alignItems: 'center',
            opacity: acceptedTerms ? 1 : 0.5,
          }]}
        >
          <Text style={{ 
            color: isDark ? '#000000' : '#FFFFFF',
            fontSize: 16,
            fontFamily: 'Roobert-Medium',
          }}>
            {t('auth.signUp')}
          </Text>
        </AnimatedPressable>

        <AnimatedPressable
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onSignIn();
          }}
          onPressIn={() => {
            scale2.value = withSpring(0.96, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            scale2.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[animatedStyle2, { 
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: isDark ? '#454444' : '#c2c2c2',
            height: 56,
            borderRadius: 28,
            justifyContent: 'center',
            alignItems: 'center',
          }]}
        >
          <Text className="text-foreground text-[16px] font-roobert-medium">
            {t('auth.logIn')}
          </Text>
        </AnimatedPressable>
      </View>
    </AnimatedView>
  );
}

interface SignInViewProps {
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  showPassword: boolean;
  setShowPassword: (show: boolean) => void;
  error: string;
  isLoading: boolean;
  onSubmit: () => void;
  onBack: () => void;
  onSignUp: () => void;
  onOAuthSignIn: (provider: 'apple' | 'google') => void;
  emailInputRef: React.RefObject<TextInput | null>;
  passwordInputRef: React.RefObject<TextInput | null>;
}

function SignInView({
  email,
  setEmail,
  password,
  setPassword,
  showPassword,
  setShowPassword,
  error,
  isLoading,
  onSubmit,
  onBack,
  onSignUp,
  onOAuthSignIn,
  emailInputRef,
  passwordInputRef,
}: SignInViewProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const isDark = colorScheme === 'dark';
  const canSubmit = email.length > 0 && password.length > 0 && !isLoading;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
      keyboardVerticalOffset={0}
    >
      <ScrollView 
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 32, paddingVertical: 64, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View className="flex-row justify-between items-center mb-16">
        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            onBack();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text className="text-muted-foreground text-[16px] font-roobert">
            {t('common.back')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            onSignUp();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text className="text-foreground text-[16px] font-roobert-medium">
            {t('auth.signUp')}
          </Text>
        </TouchableOpacity>
      </View>

      <View className="flex-1">
        <View>
          <View className="-mb-2">
            <KortixLogo variant="logomark" size={64} color={isDark ? 'dark' : 'light'} />
          </View>
          <Text className="text-[36px] font-roobert-semibold text-foreground leading-tight mb-8">
            {t('auth.logIn')}
          </Text>
        </View>

        <View className="gap-3 mb-6">
          <AppleSignInButton
            onPress={() => onOAuthSignIn('apple')}
            label={t('auth.continueWithApple')}
          />
          <GoogleSignInButton
            onPress={() => onOAuthSignIn('google')}
            label={t('auth.continueWithGoogle')}
          />
        </View>

        <View className="flex-row items-center mb-6">
          <View className="flex-1 h-px bg-border" />
          <Text className="text-muted-foreground text-[14px] font-roobert mx-4">{t('auth.or')}</Text>
          <View className="flex-1 h-px bg-border" />
        </View>

        <View className="gap-4 mb-6">
          <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 justify-center">
            <TextInput
              ref={emailInputRef}
              value={email}
              onChangeText={(text) => setEmail(text.trim().toLowerCase())}
              placeholder={t('auth.emailPlaceholder')}
              placeholderTextColor="hsl(var(--muted-foreground))"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
              className="text-foreground"
            />
          </View>

          <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
            <TextInput
              ref={passwordInputRef}
              value={password}
              onChangeText={setPassword}
              placeholder={t('auth.passwordPlaceholder')}
              placeholderTextColor="hsl(var(--muted-foreground))"
              secureTextEntry={!showPassword}
              textContentType="password"
              autoComplete="password"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={canSubmit ? onSubmit : undefined}
              style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
              className="flex-1 text-foreground"
            />
            <TouchableOpacity
              onPress={() => {
                setShowPassword(!showPassword);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon
                as={showPassword ? EyeOff : Eye}
                size={20}
                className="text-muted-foreground"
              />
            </TouchableOpacity>
          </View>
        </View>

        {error && (
          <AnimatedView entering={FadeIn.duration(200)} className="mb-4">
            <Text className="text-destructive text-[14px] font-roobert text-center">
              {error}
            </Text>
          </AnimatedView>
        )}

        <AnimatedPressable
          onPress={canSubmit ? onSubmit : undefined}
          disabled={!canSubmit}
          onPressIn={() => {
            if (canSubmit) {
              buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
            }
          }}
          onPressOut={() => {
            buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[buttonAnimatedStyle, { 
            backgroundColor: canSubmit ? (isDark ? '#FFFFFF' : '#000000') : '#888888',
            height: 56,
            borderRadius: 28,
            justifyContent: 'center',
            alignItems: 'center',
            opacity: canSubmit ? 1 : 0.5,
          }]}
        >
          {isLoading ? (
            <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
          ) : (
            <Text style={{ 
              color: isDark ? '#000000' : '#FFFFFF',
              fontSize: 16,
              fontFamily: 'Roobert-Medium',
            }}>
              {t('auth.logIn')}
            </Text>
          )}
        </AnimatedPressable>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

interface SignUpViewProps {
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  confirmPassword: string;
  setConfirmPassword: (password: string) => void;
  showPassword: boolean;
  setShowPassword: (show: boolean) => void;
  showConfirmPassword: boolean;
  setShowConfirmPassword: (show: boolean) => void;
  acceptedTerms: boolean;
  setAcceptedTerms: (accepted: boolean) => void;
  error: string;
  isLoading: boolean;
  onSubmit: () => void;
  onBack: () => void;
  onSignIn: () => void;
  onOAuthSignIn: (provider: 'apple' | 'google') => void;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
  emailInputRef: React.RefObject<TextInput | null>;
  passwordInputRef: React.RefObject<TextInput | null>;
  confirmPasswordInputRef: React.RefObject<TextInput | null>;
}

function SignUpView({
  email,
  setEmail,
  password,
  setPassword,
  confirmPassword,
  setConfirmPassword,
  showPassword,
  setShowPassword,
  showConfirmPassword,
  setShowConfirmPassword,
  acceptedTerms,
  setAcceptedTerms,
  error,
  isLoading,
  onSubmit,
  onBack,
  onSignIn,
  onOAuthSignIn,
  onOpenTerms,
  onOpenPrivacy,
  emailInputRef,
  passwordInputRef,
  confirmPasswordInputRef,
}: SignUpViewProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const buttonScale = useSharedValue(1);

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const isDark = colorScheme === 'dark';
  const passwordsMatch = password === confirmPassword || confirmPassword.length === 0;
  const canSubmit = 
    email.length > 0 && 
    password.length >= 8 && 
    confirmPassword.length > 0 && 
    passwordsMatch && 
    !isLoading;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
      keyboardVerticalOffset={0}
    >
      <ScrollView 
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 32, paddingVertical: 64, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View className="flex-row justify-between items-center mb-16">
        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            onBack();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text className="text-muted-foreground text-[16px] font-roobert">
            {t('common.back')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            Keyboard.dismiss();
            onSignIn();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text className="text-foreground text-[16px] font-roobert-medium">
            {t('auth.logIn')}
          </Text>
        </TouchableOpacity>
      </View>

      <View className="flex-1">
        <View>
          <View className="-mb-2">
            <KortixLogo variant="logomark" size={64} color={isDark ? 'dark' : 'light'} />
          </View>
          <Text className="text-[36px] font-roobert-semibold text-foreground leading-tight mb-8">
            {t('auth.createAccount')}
          </Text>
        </View>

        <View className="gap-3 mb-6">
          <AppleSignInButton
            onPress={() => onOAuthSignIn('apple')}
            label={t('auth.continueWithApple')}
          />
          <GoogleSignInButton
            onPress={() => onOAuthSignIn('google')}
            label={t('auth.continueWithGoogle')}
          />
        </View>

        <View className="flex-row items-center mb-6">
          <View className="flex-1 h-px bg-border" />
          <Text className="text-muted-foreground text-[14px] font-roobert mx-4">{t('auth.or')}</Text>
          <View className="flex-1 h-px bg-border" />
        </View>

        <View className="gap-4 mb-6">
          <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 justify-center">
            <TextInput
              ref={emailInputRef}
              value={email}
              onChangeText={(text) => setEmail(text.trim().toLowerCase())}
              placeholder={t('auth.emailPlaceholder')}
              placeholderTextColor="hsl(var(--muted-foreground))"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={() => passwordInputRef.current?.focus()}
              style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
              className="text-foreground"
            />
          </View>

          <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
            <TextInput
              ref={passwordInputRef}
              value={password}
              onChangeText={setPassword}
              placeholder={t('auth.passwordPlaceholder')}
              placeholderTextColor="hsl(var(--muted-foreground))"
              secureTextEntry={!showPassword}
              textContentType="newPassword"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
              onSubmitEditing={() => confirmPasswordInputRef.current?.focus()}
              style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
              className="flex-1 text-foreground"
            />
            <TouchableOpacity
              onPress={() => {
                setShowPassword(!showPassword);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon
                as={showPassword ? EyeOff : Eye}
                size={20}
                className="text-muted-foreground"
              />
            </TouchableOpacity>
          </View>

          <View className="bg-muted/10 dark:bg-muted/30 rounded-[20px] h-14 px-5 flex-row items-center">
            <TextInput
              ref={confirmPasswordInputRef}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder={t('auth.confirmPasswordPlaceholder')}
              placeholderTextColor="hsl(var(--muted-foreground))"
              secureTextEntry={!showConfirmPassword}
              textContentType="newPassword"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={canSubmit ? onSubmit : undefined}
              style={{ fontFamily: 'Roobert-Regular', fontSize: 16 }}
              className="flex-1 text-foreground"
            />
            <TouchableOpacity
              onPress={() => {
                setShowConfirmPassword(!showConfirmPassword);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon
                as={showConfirmPassword ? EyeOff : Eye}
                size={20}
                className="text-muted-foreground"
              />
            </TouchableOpacity>
          </View>
        </View>

        {!passwordsMatch && confirmPassword.length > 0 && (
          <AnimatedView entering={FadeIn.duration(200)} className="mb-4">
            <Text className="text-destructive text-[14px] font-roobert text-center">
              {t('auth.passwordsDontMatch')}
            </Text>
          </AnimatedView>
        )}

        {error && (
          <AnimatedView entering={FadeIn.duration(200)} className="mb-4">
            <Text className="text-destructive text-[14px] font-roobert text-center">
              {error}
            </Text>
          </AnimatedView>
        )}

        <AnimatedPressable
          onPress={canSubmit ? onSubmit : undefined}
          disabled={!canSubmit}
          onPressIn={() => {
            if (canSubmit) {
              buttonScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
            }
          }}
          onPressOut={() => {
            buttonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          style={[buttonAnimatedStyle, { 
            backgroundColor: canSubmit ? (isDark ? '#FFFFFF' : '#000000') : '#888888',
            height: 56,
            borderRadius: 28,
            justifyContent: 'center',
            alignItems: 'center',
            opacity: canSubmit ? 1 : 0.5,
          }]}
        >
          {isLoading ? (
            <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
          ) : (
            <Text style={{ 
              color: isDark ? '#000000' : '#FFFFFF',
              fontSize: 16,
              fontFamily: 'Roobert-Medium',
            }}>
              {t('auth.signUp')}
            </Text>
          )}
        </AnimatedPressable>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

interface AppleSignInButtonProps {
  onPress: () => void;
  label: string;
}

function AppleSignInButton({ onPress, label }: AppleSignInButtonProps) {
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
      className="h-12 rounded-2xl bg-[#000000] flex-row items-center justify-center gap-2"
    >
      <FontAwesome5 name="apple" size={20} color="white" />
      <Text className="text-[15px] font-roobert-medium text-white">
        {label}
      </Text>
    </AnimatedPressable>
  );
}

interface GoogleSignInButtonProps {
  onPress: () => void;
  label: string;
}

function GoogleSignInButton({ onPress, label }: GoogleSignInButtonProps) {
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
      className="h-12 rounded-2xl bg-white border border-[#dadce0] flex-row items-center justify-center gap-2"
    >
      <GoogleLogo />
      <Text className="text-[15px] font-roobert-medium text-[#1f1f1f]">
        {label}
      </Text>
    </AnimatedPressable>
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

function GmailLogo() {
  return (
    <Svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <Path
        d="M18 4.5L10 10.5L2 4.5V3.5C2 2.67157 2.67157 2 3.5 2H16.5C17.3284 2 18 2.67157 18 3.5V4.5Z"
        fill="#EA4335"
      />
      <Path
        d="M2 4.5V16.5C2 17.3284 2.67157 18 3.5 18H6V10L2 6.5V4.5Z"
        fill="#FBBC05"
      />
      <Path
        d="M18 4.5V16.5C18 17.3284 17.3284 18 16.5 18H14V10L18 6.5V4.5Z"
        fill="#34A853"
      />
      <Path
        d="M6 18H14V10L10 13L6 10V18Z"
        fill="#C5221F"
      />
    </Svg>
  );
}

function OutlookLogo() {
  return (
    <Svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <Path
        d="M3 3H17C17.5523 3 18 3.44772 18 4V16C18 16.5523 17.5523 17 17 17H3C2.44772 17 2 16.5523 2 16V4C2 3.44772 2.44772 3 3 3Z"
        fill="#0078D4"
      />
      <Path
        d="M10 9C11.1046 9 12 9.89543 12 11C12 12.1046 11.1046 13 10 13C8.89543 13 8 12.1046 8 11C8 9.89543 8.89543 9 10 9Z"
        fill="white"
      />
      <Path
        d="M7 6.5C7.82843 6.5 8.5 7.17157 8.5 8C8.5 8.82843 7.82843 9.5 7 9.5C6.17157 9.5 5.5 8.82843 5.5 8C5.5 7.17157 6.17157 6.5 7 6.5Z"
        fill="white"
      />
      <Path
        d="M13 6.5C13.8284 6.5 14.5 7.17157 14.5 8C14.5 8.82843 13.8284 9.5 13 9.5C12.1716 9.5 11.5 8.82843 11.5 8C11.5 7.17157 12.1716 6.5 13 6.5Z"
        fill="white"
      />
    </Svg>
  );
}

interface EmailAppButtonProps {
  onPress: () => void;
  appName: string;
  logo: React.ReactNode;
  variant?: 'primary' | 'secondary';
}

function EmailAppButton({ onPress, appName, logo, variant = 'secondary' }: EmailAppButtonProps) {
  const scale = useSharedValue(1);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const isPrimary = variant === 'primary';

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
        backgroundColor: isPrimary ? (isDark ? '#FFFFFF' : '#000000') : '',
        borderWidth: isPrimary ? 0 : 1,
        borderColor: isPrimary ? 'transparent' : (isDark ? '#454444' : '#c2c2c2'),
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'row',
        gap: 8,
      }]}
    >
      {logo}
      <Text style={{ 
        color: isPrimary ? (isDark ? '#000000' : '#FFFFFF') : (isDark ? '#FFFFFF' : '#000000'),
        fontSize: 16,
        fontFamily: 'Roobert-Medium',
      }}>
        {appName}
      </Text>
    </AnimatedPressable>
  );
}

function EmailConfirmationView({ 
  email, 
  onBack 
}: { 
  email: string; 
  onBack: () => void;
}) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handleOpenEmail = async (app?: string) => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (app) {
        await openInbox({ app });
      } else {
        await openInbox({});
      }
    } catch (error) {
      console.error('Failed to open email app:', error);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <View className="absolute top-0 left-0 right-0 pt-16 px-8 z-10">
        <TouchableOpacity
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onBack();
          }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text className="text-muted-foreground text-[16px] font-roobert">
            Back
          </Text>
        </TouchableOpacity>
      </View>
      <View className='absolute inset-0' pointerEvents="none">
        <BackgroundLogo/>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <AnimatedView 
          entering={FadeIn.duration(400)}
          className="flex-1 justify-end px-8 py-16"
        >
          <View className="justify-center">
            <View className="mb-6 h-20 w-20 items-center justify-center rounded-3xl bg-rose-500">
              <Icon as={MailCheck} size={36} className="text-white" strokeWidth={2} />
            </View>
            <Text className="text-[36px] font-roobert-semibold text-foreground leading-tight mb-3">
              {t('auth.checkYourEmail')}
            </Text>
            <Text className="text-[16px] font-roobert text-muted-foreground mb-2">
              {t('auth.confirmationEmailSent')}
            </Text>
            <View className="mb-8 bg-muted/10 dark:bg-muted/30 rounded-[20px] px-5 py-4">
              <Text className="text-[15px] font-roobert-medium text-foreground">
                {email}
              </Text>
            </View>
          </View>

          <View className="w-full gap-4">
            {Platform.OS === 'ios' && (
              <EmailAppButton
                onPress={() => handleOpenEmail()}
                appName={t('auth.openEmailAppBtn')}
                logo={
                  <Icon as={Mail} size={20} color={isDark ? '#000000' : '#FFFFFF'} strokeWidth={2.5} />
                }
                variant="primary"
              />
            )}
            <EmailAppButton
              onPress={() => handleOpenEmail('gmail')}
                appName={t('auth.openGmailBtn')}
              logo={
                <MaterialCommunityIcons name="gmail" size={22} color={isDark ? '#FFFFFF' : '#000000'} />
              }
            />
          </View>
        </AnimatedView>
      </ScrollView>
    </View>
  );
}
