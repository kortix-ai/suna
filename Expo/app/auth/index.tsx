import * as React from 'react';
import { View, Pressable, TextInput, KeyboardAvoidingView, Platform, ScrollView, Keyboard, ActivityIndicator, ActionSheetIOS } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Mail, ArrowRight, ChevronLeft, Check } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useLanguage } from '@/contexts';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import * as Haptics from 'expo-haptics';
import { openInbox } from 'react-native-email-link';
import * as WebBrowser from 'expo-web-browser';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type AuthView = 'main' | 'sign-in' | 'sign-up' | 'sign-in-email' | 'sign-up-email' | 'sign-up-success' | 'forgot-password';

/**
 * Unified Auth Screen
 * 
 * Single screen that handles all authentication flows:
 * - OAuth (Apple & Google)
 * - Email Sign In
 * - Email Sign Up
 * - Forgot Password
 * 
 * All states are managed within one screen for seamless transitions
 */
export default function AuthScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signIn, signUp, signInWithOAuth, resetPassword, isLoading } = useAuth();
  const { hasCompletedOnboarding } = useOnboarding();
  
  // View state
  const [currentView, setCurrentView] = React.useState<AuthView>('main');
  
  // Form fields
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [error, setError] = React.useState('');
  const [forgotPasswordSuccess, setForgotPasswordSuccess] = React.useState(false);
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  
  // Refs
  const nameInputRef = React.useRef<TextInput>(null);
  const emailInputRef = React.useRef<TextInput>(null);
  const passwordInputRef = React.useRef<TextInput>(null);
  const confirmPasswordInputRef = React.useRef<TextInput>(null);

  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

  // Handle opening email app with native iOS ActionSheet
  const handleOpenEmailApp = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    if (Platform.OS === 'ios') {
      // Use native iOS ActionSheet
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Default', 'Apple Mail', 'Gmail', 'Outlook', 'Yahoo Mail'],
          cancelButtonIndex: 0,
          title: 'Choose Email App',
          message: 'Select your preferred email app',
        },
        async (buttonIndex) => {
          // Index 0: Cancel
          // Index 1: Default (no app specified - opens system default)
          // Index 2+: Specific apps
          const apps = ['', '', 'apple-mail', 'gmail', 'outlook', 'yahoo-mail'];
          
          if (buttonIndex > 0) {
            console.log('🔗 Opening email app:', buttonIndex === 1 ? 'default' : apps[buttonIndex]);
            try {
              if (buttonIndex === 1) {
                // Open default email app (no app parameter)
                await openInbox();
              } else {
                // Open specific app
                await openInbox({ app: apps[buttonIndex] });
              }
              console.log('✅ Successfully opened email app');
            } catch (error) {
              console.error('❌ Error opening email app:', error);
            }
          }
        }
      );
    } else {
      // Android: Just open default email app
      console.log('🔗 Opening default email app on Android');
      openInbox().catch((error) => {
        console.error('❌ Error opening email app:', error);
      });
    }
  };

  // Navigation helpers
  const handleNavigateToHome = React.useCallback(() => {
    if (!hasCompletedOnboarding) {
      router.replace('/onboarding');
    } else {
      router.replace('/home');
    }
  }, [hasCompletedOnboarding, router]);

  const handleBack = React.useCallback(() => {
    Keyboard.dismiss();
    setCurrentView('main');
    setError('');
    setForgotPasswordSuccess(false);
    setAcceptedTerms(false);
  }, []);

  // Open legal pages
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

  // OAuth
  const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
    console.log('🎯 OAuth sign in:', provider);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    const result = await signInWithOAuth(provider);
    
    if (result.success) {
      console.log('✅ OAuth successful');
      handleNavigateToHome();
    } else {
      console.error('❌ OAuth failed:', result.error);
      setError(result.error?.message || t('auth.signInFailed'));
    }
  };

  // Email Sign In
  const handleSignIn = async () => {
    if (!email || !password) {
      setError(t('auth.enterEmailPassword'));
      return;
    }

    console.log('🎯 Email sign in attempt:', email);
    const result = await signIn({ email, password });

    if (result.success) {
      console.log('✅ Sign in successful');
      handleNavigateToHome();
    } else {
      console.log('❌ Sign in failed:', result.error);
      setError(result.error?.message || t('auth.signInFailed'));
    }
  };

  // Email Sign Up
  const handleSignUp = async () => {
    if (!email || !password) {
      setError(t('auth.enterEmailPassword'));
      return;
    }

    if (password !== confirmPassword) {
      setError(t('auth.passwordsDontMatch'));
      return;
    }

    if (password.length < 8) {
      setError(t('auth.passwordTooShort'));
      return;
    }

    if (!acceptedTerms) {
      setError('Please accept the Privacy Policy and Terms of Service');
      return;
    }

    console.log('🎯 Email sign up attempt:', email);
    const result = await signUp({ email, password, fullName });

    if (result.success) {
      console.log('✅ Sign up successful - showing email verification');
      setCurrentView('sign-up-success');
      setError('');
    } else {
      console.log('❌ Sign up failed:', result.error);
      setError(result.error?.message || t('auth.signUpFailed'));
    }
  };

  // Forgot Password
  const handleResetPassword = async () => {
    if (!email) {
      setError(t('auth.enterEmailAddress'));
      return;
    }

    console.log('🎯 Password reset request:', email);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    const result = await resetPassword({ email });

    if (result.success) {
      console.log('✅ Password reset email sent');
      setForgotPasswordSuccess(true);
      setError('');
    } else {
      console.log('❌ Password reset failed:', result.error);
      setError(result.error?.message || t('auth.resetFailed'));
    }
  };

  // View transitions
  const showSignIn = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-in');
    setError('');
    // Clear form fields when navigating to sign in
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setFullName('');
  };

  const showSignInEmail = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-in-email');
    setError('');
  };

  const showSignUp = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-up');
    setError('');
    // Clear form fields when navigating to sign up
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setFullName('');
  };

  const showSignUpEmail = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-up-email');
    setError('');
  };

  const showForgotPassword = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('forgot-password');
    setError('');
    setForgotPasswordSuccess(false);
  };

  const showSignInEmailWithPrefilledData = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView('sign-in-email');
    setError('');
    // Keep email and password prefilled, clear confirm password and full name
    setConfirmPassword('');
    setFullName('');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1 bg-background"
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow justify-center"
          keyboardShouldPersistTaps="handled"
        >
          <View className="flex-1 justify-center px-6 py-8">
            {/* Main View - OAuth Options */}
            {currentView === 'main' && (
              <View className="items-center">
                {/* Logo */}
                <View className="mb-12">
                  <Logomark width={224} height={44} />
                </View>

                {/* Title */}
                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-8 px-4">
                  {t('auth.createFreeAccount')}
                </Text>

                {/* Auth Buttons */}
                <View className="gap-3 mb-8 w-full max-w-sm">
                  <AppleSignInButton
                    onPress={() => handleOAuthSignIn('apple')}
                    label={t('auth.continueWithApple')}
                  />
                  <GoogleSignInButton
                    onPress={() => handleOAuthSignIn('google')}
                    label={t('auth.continueWithGoogle')}
                  />
                  <EmailSignInButton
                    onPress={showSignInEmail}
                    label={t('auth.signInWithEmail')}
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert text-center mb-4">
                    {error}
                  </Text>
                )}

                {/* Sign Up Link */}
                <Pressable onPress={showSignUp} className="mt-4">
                  <View className="flex-row justify-center items-center">
                    <Text className="text-[14px] font-roobert text-muted-foreground">
                      {t('auth.dontHaveAccount')}{' '}
                    </Text>
                    <Text className="text-[14px] font-roobert-medium text-primary">
                      {t('auth.signUp')}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}

            {/* Sign In Options View */}
            {currentView === 'sign-in' && (
              <View className="items-center">
                {/* Logo */}
                <View className="mb-12">
                  <Logomark width={224} height={44} />
                </View>

                {/* Title */}
                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-8 px-4">
                  {t('auth.signIn')}
                </Text>

                {/* Auth Buttons */}
                <View className="gap-3 mb-8 w-full max-w-sm">
                  <AppleSignInButton
                    onPress={() => handleOAuthSignIn('apple')}
                    label={t('auth.continueWithApple')}
                  />
                  <GoogleSignInButton
                    onPress={() => handleOAuthSignIn('google')}
                    label={t('auth.continueWithGoogle')}
                  />
                  <EmailSignInButton
                    onPress={showSignInEmail}
                    label={t('auth.signInWithEmail')}
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert text-center mb-4">
                    {error}
                  </Text>
                )}

                {/* Sign Up Link */}
                <Pressable onPress={showSignUp} className="mt-4">
                  <View className="flex-row justify-center items-center">
                    <Text className="text-[14px] font-roobert text-muted-foreground">
                      {t('auth.dontHaveAccount')}{' '}
                    </Text>
                    <Text className="text-[14px] font-roobert-medium text-primary">
                      {t('auth.signUp')}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}

            {/* Sign Up Options View */}
            {currentView === 'sign-up' && (
              <View className="items-center">
                {/* Logo */}
                <View className="mb-12">
                  <Logomark width={224} height={44} />
                </View>

                {/* Title */}
                <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-8 px-4">
                  {t('auth.createFreeAccount')}
                </Text>

                {/* Auth Buttons */}
                <View className="gap-3 mb-8 w-full max-w-sm">
                  <AppleSignInButton
                    onPress={() => handleOAuthSignIn('apple')}
                    label={t('auth.continueWithApple')}
                  />
                  <GoogleSignInButton
                    onPress={() => handleOAuthSignIn('google')}
                    label={t('auth.continueWithGoogle')}
                  />
                  <EmailSignInButton
                    onPress={showSignUpEmail}
                    label={t('auth.signUpWithEmail')}
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert text-center mb-4">
                    {error}
                  </Text>
                )}

                {/* Sign In Link */}
                <Pressable onPress={showSignIn} className="mt-4">
                  <View className="flex-row justify-center items-center">
                    <Text className="text-[14px] font-roobert text-muted-foreground">
                      {t('auth.alreadyHaveAccount')}{' '}
                    </Text>
                    <Text className="text-[14px] font-roobert-medium text-primary">
                      {t('auth.signIn')}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}

            {/* Sign In Email Form View */}
            {currentView === 'sign-in-email' && (
              <View className="w-full max-w-sm mx-auto">
                {/* Back Button */}
                <Pressable 
                  onPress={handleBack} 
                  className="size-10 justify-center mb-8 self-start"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={ChevronLeft} size={24} className="text-foreground" />
                </Pressable>

                <Text className="text-2xl font-roobert-semibold text-foreground mb-8 text-center">
                  {t('auth.signInWithEmail')}
                </Text>

                {/* Email Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-3">
                  <TextInput
                    ref={emailInputRef}
                    value={email}
                    onChangeText={setEmail}
                    placeholder={t('auth.emailPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus={true}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordInputRef.current?.focus()}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Password Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-4">
                  <TextInput
                    ref={passwordInputRef}
                    value={password}
                    onChangeText={setPassword}
                    placeholder={t('auth.passwordPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    textContentType="password"
                    autoComplete="password"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleSignIn}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert mb-4 text-center">
                    {error}
                  </Text>
                )}

                {/* Sign In Button */}
                <Pressable
                  onPress={handleSignIn}
                  disabled={isLoading}
                  style={{
                    backgroundColor: colorScheme === 'dark' ? '#F8F8F8' : '#000000',
                    height: 48,
                    borderRadius: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    marginBottom: 16,
                    opacity: isLoading ? 0.7 : 1,
                  }}
                >
                  {isLoading && (
                    <ActivityIndicator 
                      size="small" 
                      color={colorScheme === 'dark' ? '#000000' : '#FFFFFF'} 
                    />
                  )}
                  <Text 
                    style={{
                      fontSize: 15,
                      fontWeight: '500',
                      color: colorScheme === 'dark' ? '#000000' : '#FFFFFF',
                    }}
                  >
                    {isLoading ? t('auth.signingIn') : t('auth.signIn')}
                  </Text>
                  {!isLoading && (
                    <Icon 
                      as={ArrowRight} 
                      size={16} 
                      color={colorScheme === 'dark' ? '#000000' : '#FFFFFF'} 
                    />
                  )}
                </Pressable>

                {/* Forgot Password */}
                <Pressable onPress={showForgotPassword} className="mt-2">
                  <Text className="text-[14px] font-roobert-medium text-muted-foreground text-center">
                    {t('auth.forgotPassword')}
                  </Text>
                </Pressable>

                {/* Sign Up Link */}
                <Pressable onPress={showSignUp} className="mt-4">
                  <View className="flex-row justify-center items-center">
                    <Text className="text-[14px] font-roobert text-muted-foreground">
                      {t('auth.dontHaveAccount')}{' '}
                    </Text>
                    <Text className="text-[14px] font-roobert-medium text-primary">
                      {t('auth.signUp')}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}

            {/* Sign Up Email Form View */}
            {currentView === 'sign-up-email' && (
              <View className="w-full max-w-sm mx-auto">
                {/* Back Button */}
                <Pressable 
                  onPress={handleBack} 
                  className="size-10 justify-center mb-8 self-start"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={ChevronLeft} size={24} className="text-foreground" />
                </Pressable>

                <Text className="text-2xl font-roobert-semibold text-foreground mb-8 text-center">
                  {t('auth.createAccount')}
                </Text>

                {/* Email Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-3">
                  <TextInput
                    ref={emailInputRef}
                    value={email}
                    onChangeText={setEmail}
                    placeholder={t('auth.emailPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus={true}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordInputRef.current?.focus()}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Password Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-3">
                  <TextInput
                    ref={passwordInputRef}
                    value={password}
                    onChangeText={setPassword}
                    placeholder={t('auth.passwordPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    textContentType="newPassword"
                    autoComplete="password-new"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                    onSubmitEditing={() => confirmPasswordInputRef.current?.focus()}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Confirm Password Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-4">
                  <TextInput
                    ref={confirmPasswordInputRef}
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    textContentType="newPassword"
                    autoComplete="password-new"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleSignUp}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert mb-4 text-center">
                    {error}
                  </Text>
                )}

                {/* GDPR Consent Checkbox */}
                <View className="flex-row items-center my-4 px-1">
                  <Pressable 
                    onPress={() => {
                      setAcceptedTerms(!acceptedTerms);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    className="mr-3"
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <View className={`size-5 rounded border-2 items-center justify-center ${
                      acceptedTerms ? 'bg-primary border-primary' : 'border-border bg-card'
                    }`}>
                      {acceptedTerms && (
                        <Icon as={Check} size={14} className="text-primary-foreground" />
                      )}
                    </View>
                  </Pressable>
                  
                  <View className="flex-1 flex-row flex-wrap items-center">
                    <Text className="text-xs font-roobert text-foreground leading-5">
                      I accept the{' '}
                    </Text>
                    <Pressable onPress={handleOpenPrivacy}>
                      <Text className="text-xs font-roobert text-foreground leading-5">
                        Privacy Policy
                      </Text>
                    </Pressable>
                    <Text className="text-xs font-roobert text-foreground leading-5">
                      {' '}and{' '}
                    </Text>
                    <Pressable onPress={handleOpenTerms}>
                      <Text className="text-xs font-roobert text-foreground leading-5">
                        Terms of Service
                      </Text>
                    </Pressable>
                  </View>
                </View>

                {/* Sign Up Button */}
                <Pressable
                  onPress={handleSignUp}
                  disabled={isLoading || !acceptedTerms}
                  style={{
                    backgroundColor: (acceptedTerms && !isLoading) 
                      ? (colorScheme === 'dark' ? '#F8F8F8' : '#000000')
                      : '#888888',
                    height: 48,
                    borderRadius: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    marginBottom: 16,
                    opacity: (isLoading || !acceptedTerms) ? 0.5 : 1,
                  }}
                >
                  {isLoading && (
                    <ActivityIndicator 
                      size="small" 
                      color={colorScheme === 'dark' ? '#000000' : '#FFFFFF'} 
                    />
                  )}
                  <Text 
                    style={{
                      fontSize: 15,
                      fontWeight: '500',
                      color: colorScheme === 'dark' ? '#000000' : '#FFFFFF',
                    }}
                  >
                    {isLoading ? t('auth.creatingAccount') : t('auth.createAccount')}
                  </Text>
                  {!isLoading && (
                    <Icon 
                      as={ArrowRight} 
                      size={16} 
                      color={colorScheme === 'dark' ? '#000000' : '#FFFFFF'} 
                    />
                  )}
                </Pressable>

                {/* Sign In Link */}
                <Pressable onPress={showSignIn} className="mt-2">
                  <View className="flex-row justify-center items-center">
                    <Text className="text-[14px] font-roobert text-muted-foreground">
                      {t('auth.alreadyHaveAccount')}{' '}
                    </Text>
                    <Text className="text-[14px] font-roobert-medium text-primary">
                      {t('auth.signIn')}
                    </Text>
                  </View>
                </Pressable>
              </View>
            )}

            {/* Sign Up Success View */}
            {currentView === 'sign-up-success' && (
              <View className="w-full max-w-sm mx-auto">
                <View className="items-center mb-8">
                  <View className="size-16 rounded-full bg-primary/10 items-center justify-center mb-4">
                    <Icon as={Mail} size={32} className="text-primary" />
                  </View>
                  
                  <Text className="text-2xl font-roobert-semibold text-foreground text-center mb-3">
                    {t('auth.checkYourEmail')}
                  </Text>
                  
                  <Text className="text-[15px] font-roobert text-muted-foreground text-center px-4">
                    {t('auth.verificationEmailSent')}{'\n'}
                    <Text className="font-roobert-medium text-foreground">{email}</Text>
                  </Text>
                </View>

                {/* Open Email App Button */}
                <Pressable
                  onPress={handleOpenEmailApp}
                  className="bg-primary h-12 rounded-2xl flex-row items-center justify-center gap-2 mb-3"
                >
                  <Icon as={Mail} size={18} className="text-primary-foreground" />
                  <Text className="text-[15px] font-roobert-medium text-primary-foreground">
                    {t('auth.openEmailApp')}
                  </Text>
                </Pressable>

                {/* Go to Sign In Button */}
                <Pressable
                  onPress={showSignInEmailWithPrefilledData}
                  className="bg-card border border-border h-12 rounded-2xl flex-row items-center justify-center gap-2"
                >
                  <Text className="text-[15px] font-roobert-medium text-foreground">
                    {t('auth.goToSignIn')}
                  </Text>
                </Pressable>

                {/* Info Text */}
                <View className="mt-6">
                  <Text className="text-[14px] font-roobert text-muted-foreground text-center">
                    {t('auth.verifyEmailInstructions')}
                  </Text>
                </View>
              </View>
            )}

            {/* Forgot Password View */}
            {currentView === 'forgot-password' && !forgotPasswordSuccess && (
              <View className="w-full max-w-sm mx-auto">
                {/* Back Button */}
                <Pressable 
                  onPress={handleBack} 
                  className="size-10 justify-center mb-8 self-start"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={ChevronLeft} size={24} className="text-foreground" />
                </Pressable>

                <Text className="text-2xl font-roobert-semibold text-foreground mb-2 text-center">
                  {t('auth.resetPassword')}
                </Text>
              
                <Text className="text-[15px] font-roobert text-muted-foreground mb-8 text-center">
                  {t('auth.resetPasswordDescription')}
                </Text>

                {/* Email Input */}
                <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-4">
                  <TextInput
                    ref={emailInputRef}
                    value={email}
                    onChangeText={setEmail}
                    placeholder={t('auth.emailPlaceholder')}
                    placeholderTextColor="hsl(var(--muted-foreground))"
                    keyboardType="email-address"
                    textContentType="emailAddress"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus={true}
                    returnKeyType="send"
                    onSubmitEditing={handleResetPassword}
                    style={{ fontFamily: 'Roobert-Regular' }}
                    className="flex-1 text-foreground text-[15px]"
                  />
                </View>

                {/* Error Message */}
                {error && (
                  <Text className="text-destructive text-sm font-roobert mb-4 text-center">
                    {error}
                  </Text>
                )}

                {/* Reset Password Button */}
                <Pressable
                  onPress={handleResetPassword}
                  disabled={isLoading}
                  className="bg-primary h-12 rounded-2xl flex-row items-center justify-center gap-2"
                >
                  <Text className="text-[15px] font-roobert-medium text-primary-foreground">
                    {isLoading ? t('auth.sending') : t('auth.sendResetLink')}
                  </Text>
                  {!isLoading && (
                    <Icon as={ArrowRight} size={16} className="text-primary-foreground" />
                  )}
                </Pressable>
              </View>
            )}

            {/* Forgot Password Success View */}
            {currentView === 'forgot-password' && forgotPasswordSuccess && (
              <View className="w-full max-w-sm mx-auto">
                <View className="items-center mb-8">
                  <View className="size-16 rounded-full bg-primary/10 items-center justify-center mb-4">
                    <Icon as={Mail} size={32} className="text-primary" />
                  </View>
                  
                  <Text className="text-2xl font-roobert-semibold text-foreground text-center mb-3">
                    {t('auth.checkYourEmail')}
                  </Text>
                  
                  <Text className="text-[15px] font-roobert text-muted-foreground text-center px-4">
                    {t('auth.resetLinkSent')}{'\n'}
                    <Text className="font-roobert-medium text-foreground">{email}</Text>
                  </Text>
                </View>

                {/* Back to Sign In Button */}
                <Pressable
                  onPress={handleBack}
                  className="bg-primary h-12 rounded-2xl flex-row items-center justify-center gap-2"
                >
                  <Text className="text-[15px] font-roobert-medium text-primary-foreground">
                    {t('auth.backToSignIn')}
                  </Text>
                </Pressable>

                {/* Resend Link */}
                <Pressable onPress={() => setForgotPasswordSuccess(false)} className="mt-6">
                  <Text className="text-[14px] font-roobert-medium text-muted-foreground text-center">
                    {t('auth.didntReceiveEmail')}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

/**
 * Apple Sign In Button
 */
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

/**
 * Google Sign In Button
 */
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

/**
 * Official Google Logo
 */
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

/**
 * Email Sign In Button
 */
interface EmailSignInButtonProps {
  onPress: () => void;
  label: string;
}

function EmailSignInButton({ onPress, label }: EmailSignInButtonProps) {
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
      className="h-12 rounded-2xl bg-card border border-border flex-row items-center justify-center gap-2"
    >
      <Icon as={Mail} size={20} className="text-foreground" />
      <Text className="text-[15px] font-roobert-medium text-foreground">
        {label}
      </Text>
    </AnimatedPressable>
  );
}

