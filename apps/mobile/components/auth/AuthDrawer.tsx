import * as React from 'react';
import { View, TouchableOpacity, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, Check } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import BottomSheet, { BottomSheetScrollView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { SignInForm, SignUpForm } from './AuthForms';
import { useAuth } from '@/hooks/useAuth';
import { useGuestMode, useLanguage } from '@/contexts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { KortixLogo } from '@/components/ui/KortixLogo';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';
import { FontAwesome5 } from '@expo/vector-icons';
import { Mail } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';

const AnimatedPressable = Animated.createAnimatedComponent(TouchableOpacity);

type AuthMode = 'choose' | 'email-choose' | 'sign-in' | 'sign-up';

const GoogleLogo = () => {
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
};

export function AuthDrawer() {
  const { 
    isOpen, 
    title: storeTitle, 
    message: storeMessage,
    mode,
    onSuccess,
    closeAuthDrawer 
  } = useAuthDrawerStore();
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  
  const title = storeTitle || t('auth.drawer.defaultTitle');
  const message = storeMessage || t('auth.drawer.defaultMessage');
  const isDark = colorScheme === 'dark';
  const { signIn, signUp, signInWithOAuth, isLoading } = useAuth();
  const { exitGuestMode } = useGuestMode();
  const queryClient = useQueryClient();
  const router = useRouter();
  const bottomSheetRef = React.useRef<BottomSheet>(null);

  const [authMode, setAuthMode] = React.useState<AuthMode>('choose');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
  const [error, setError] = React.useState('');
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);

  const appleScale = useSharedValue(1);
  const googleScale = useSharedValue(1);
  const emailScale = useSharedValue(1);
  const loginScale = useSharedValue(1);
  const signupScale = useSharedValue(1);
  const continueScale = useSharedValue(1);

  const emailInputRef = React.useRef<TextInput>(null);
  const passwordInputRef = React.useRef<TextInput>(null);
  const confirmPasswordInputRef = React.useRef<TextInput>(null);
  const wasOpenRef = React.useRef(false);
  const cleanupTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEmailContinue = () => {
    if (!email || !email.includes('@')) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Show the choose screen with both options
    // The UI will automatically show choose screen when email is valid
  };

  const appleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: appleScale.value }],
  }));

  const googleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: googleScale.value }],
  }));

  const emailAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: emailScale.value }],
  }));

  const loginAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: loginScale.value }],
  }));

  const signupAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: signupScale.value }],
  }));

  const continueAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: continueScale.value }],
  }));

  React.useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen && !wasOpen) {
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
        cleanupTimeoutRef.current = null;
      }

      const targetMode = mode || 'choose';
      setAuthMode(targetMode);
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setError('');
      setAcceptedTerms(false);
      setShowPassword(false);
      setShowConfirmPassword(false);
      
      setTimeout(() => {
        bottomSheetRef.current?.expand();
      }, 100);
    } else if (!isOpen && wasOpen) {
      bottomSheetRef.current?.close();
    }
  }, [isOpen, mode]);

  const handleClose = () => {
    closeAuthDrawer();
    bottomSheetRef.current?.close();
    
    if (cleanupTimeoutRef.current) {
      clearTimeout(cleanupTimeoutRef.current);
    }

    cleanupTimeoutRef.current = setTimeout(() => {
      setAuthMode('choose');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setError('');
      setAcceptedTerms(false);
      setShowPassword(false);
      setShowConfirmPassword(false);
    }, 300);
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
      await exitGuestMode();
      queryClient.invalidateQueries();
      onSuccess?.();
      handleClose();
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
      await exitGuestMode();
      queryClient.invalidateQueries();
      onSuccess?.();
      handleClose();
    } else {
      setError(result.error?.message || t('auth.signUpFailed'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await signInWithOAuth(provider);
    
    if (result.success) {
      await exitGuestMode();
      queryClient.invalidateQueries();
      onSuccess?.();
      handleClose();
    } else {
      setError(result.error?.message || t('auth.signInFailed'));
    }
  };

  const handleOpenTerms = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=terms', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: isDark ? '#FFFFFF' : '#000000',
    });
  };

  const handleOpenPrivacy = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=privacy', {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      controlsColor: isDark ? '#FFFFFF' : '#000000',
    });
  };

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      enablePanDownToClose
      onClose={handleClose}
      enableDynamicSizing={true}
      backgroundStyle={{ 
        backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
      }}
      handleIndicatorStyle={{ 
        backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
      }}
      keyboardBehavior="fillParent"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backdropComponent={renderBackdrop}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ 
          paddingHorizontal: authMode === 'choose' || authMode === 'email-choose' ? 32 : 24,
          paddingTop: authMode === 'choose' || authMode === 'email-choose' ? 16 : 24,
          paddingBottom: authMode === 'choose' || authMode === 'email-choose' ? 32 : 42,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
          {authMode === 'choose' ? (
            <View className="gap-6">
              <View>
                <View className="-mb-2">
                  <KortixLogo variant="logomark" size={80} color={isDark ? 'dark' : 'light'} />
                </View>
                <Text className="text-2xl font-roobert-semibold text-foreground leading-tight mb-2">
                  {title}
                </Text>
                {message && (
                  <Text className="text-sm text-muted-foreground leading-relaxed">
                    {message}
                  </Text>
                )}
              </View>

              <View className="w-full gap-3">
                <AnimatedPressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    handleOAuthSignIn('apple');
                  }}
                  onPressIn={() => {
                    appleScale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    appleScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={[appleAnimatedStyle]}
                  className="h-12 rounded-2xl bg-[#000000] flex-row items-center justify-center gap-2"
                >
                  <FontAwesome5 name="apple" size={20} color="white" />
                  <Text className="text-[15px] font-roobert-medium text-white">
                    {t('auth.continueWithApple')}
                  </Text>
                </AnimatedPressable>

                <AnimatedPressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    handleOAuthSignIn('google');
                  }}
                  onPressIn={() => {
                    googleScale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    googleScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={[googleAnimatedStyle]}
                  className="h-12 rounded-2xl bg-white border border-[#dadce0] flex-row items-center justify-center gap-2"
                >
                  <GoogleLogo />
                  <Text className="text-[15px] font-roobert-medium text-[#1f1f1f]">
                    {t('auth.continueWithGoogle')}
                  </Text>
                </AnimatedPressable>

                <View className="flex-row items-center my-2">
                  <View className="flex-1 h-px bg-border" />
                  <Text className="text-muted-foreground text-[14px] font-roobert mx-4">{t('auth.or')}</Text>
                  <View className="flex-1 h-px bg-border" />
                </View>

                <AnimatedPressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setAuthMode('email-choose');
                    setError('');
                  }}
                  onPressIn={() => {
                    emailScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    emailScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={[emailAnimatedStyle, { 
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    borderColor: isDark ? '#454444' : '#c2c2c2',
                    height: 52,
                    borderRadius: 26,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }]}
                >
                  <View className="flex-row items-center gap-2">
                    <Icon as={Mail} size={20} className="text-foreground" />
                    <Text className="text-foreground text-[16px] font-roobert-medium">
                      {t('auth.continueWithEmail')}
                    </Text>
                  </View>
                </AnimatedPressable>
              </View>
            </View>
          ) : authMode === 'email-choose' ? (
            <View className="gap-6">
              <View className="flex-row items-center justify-between mb-2">
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setAuthMode('choose');
                    setError('');
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text className="text-muted-foreground text-[16px] font-roobert">
                    {t('common.back')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleClose}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={X} size={24} className="text-muted-foreground" />
                </TouchableOpacity>
              </View>

              <Text className="text-[28px] font-roobert-semibold text-foreground leading-tight mb-6">
                {t('auth.chooseAction')}
              </Text>

              <View className="gap-3">
                <AnimatedPressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setAuthMode('sign-in');
                    setEmail('');
                    setError('');
                  }}
                  onPressIn={() => {
                    loginScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    loginScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={[loginAnimatedStyle, { 
                    backgroundColor: isDark ? '#FFFFFF' : '#000000',
                    height: 52,
                    borderRadius: 26,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }]}
                >
                  <Text style={{ 
                    color: isDark ? '#000000' : '#FFFFFF',
                    fontSize: 16,
                    fontFamily: 'Roobert-Medium',
                  }}>
                    {t('auth.logIn')}
                  </Text>
                </AnimatedPressable>

                <AnimatedPressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setAuthMode('sign-up');
                    setEmail('');
                    setError('');
                  }}
                  onPressIn={() => {
                    signupScale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    signupScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  style={[signupAnimatedStyle, { 
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    borderColor: isDark ? '#454444' : '#c2c2c2',
                    height: 52,
                    borderRadius: 26,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }]}
                >
                  <Text className="text-foreground text-[16px] font-roobert-medium">
                    {t('auth.signUp')}
                  </Text>
                </AnimatedPressable>
              </View>
            </View>
          ) : (
            <>
              <View className="flex-row items-center justify-between mb-6">
                <TouchableOpacity
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setAuthMode('email-choose');
                    setError('');
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text className="text-muted-foreground text-[16px] font-roobert">
                    {t('common.back')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleClose}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={X} size={24} className="text-muted-foreground" />
                </TouchableOpacity>
              </View>

              {authMode === 'sign-in' ? (
                <>
                  <Text className="text-[28px] font-roobert-semibold text-foreground leading-tight mb-6">
                    {t('auth.logIn')}
                  </Text>
                  <SignInForm
                    email={email}
                    setEmail={setEmail}
                    password={password}
                    setPassword={setPassword}
                    showPassword={showPassword}
                    setShowPassword={setShowPassword}
                    error={error}
                    isLoading={isLoading}
                    onSubmit={handleSignIn}
                    hideOAuth={true}
                    emailInputRef={emailInputRef}
                    passwordInputRef={passwordInputRef}
                  />
                </>
              ) : (
                <>
                  <Text className="text-[28px] font-roobert-semibold text-foreground leading-tight mb-6">
                    {t('auth.createAccount')}
                  </Text>
                  <SignUpForm
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
                    error={error}
                    isLoading={isLoading}
                    onSubmit={handleSignUp}
                    hideOAuth={true}
                    emailInputRef={emailInputRef}
                    passwordInputRef={passwordInputRef}
                    confirmPasswordInputRef={confirmPasswordInputRef}
                    acceptedTerms={acceptedTerms}
                    setAcceptedTerms={setAcceptedTerms}
                    onOpenTerms={handleOpenTerms}
                    onOpenPrivacy={handleOpenPrivacy}
                  />
                </>
              )}
            </>
          )}
        </BottomSheetScrollView>
    </BottomSheet>
  );
}
