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

const AnimatedPressable = Animated.createAnimatedComponent(TouchableOpacity);

type AuthMode = 'choose' | 'sign-in' | 'sign-up';

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

  const scale1 = useSharedValue(1);
  const scale2 = useSharedValue(1);

  const emailInputRef = React.useRef<TextInput>(null);
  const passwordInputRef = React.useRef<TextInput>(null);
  const confirmPasswordInputRef = React.useRef<TextInput>(null);
  const wasOpenRef = React.useRef(false);
  const cleanupTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const animatedStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: scale1.value }],
  }));

  const animatedStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: scale2.value }],
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
          paddingHorizontal: authMode === 'choose' ? 32 : 24,
          paddingTop: authMode === 'choose' ? 16 : 24,
          paddingBottom: authMode === 'choose' ? 32 : 42,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
          {authMode === 'choose' ? (
            <View className="gap-8">
              <View>
                <View className="-mb-2">
                  <KortixLogo variant="logomark" size={56} color={isDark ? 'dark' : 'light'} />
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
                <View className="flex-row items-start mb-1">
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
                    setAuthMode('sign-up');
                    setError('');
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
                    height: 52,
                    borderRadius: 26,
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
                    setAuthMode('sign-in');
                    setError('');
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
                    height: 52,
                    borderRadius: 26,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }]}
                >
                  <Text className="text-foreground text-[16px] font-roobert-medium">
                    {t('auth.logIn')}
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

              {authMode === 'sign-in' ? (
                <>
                  <Text className="text-[32px] font-roobert-semibold text-foreground leading-tight mb-6">
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
                    onOAuthSignIn={handleOAuthSignIn}
                    emailInputRef={emailInputRef}
                    passwordInputRef={passwordInputRef}
                  />
                </>
              ) : (
                <>
                  <Text className="text-[32px] font-roobert-semibold text-foreground leading-tight mb-6">
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
                    onOAuthSignIn={handleOAuthSignIn}
                    emailInputRef={emailInputRef}
                    passwordInputRef={passwordInputRef}
                    confirmPasswordInputRef={confirmPasswordInputRef}
                  />
                </>
              )}
            </>
          )}
        </BottomSheetScrollView>
    </BottomSheet>
  );
}
