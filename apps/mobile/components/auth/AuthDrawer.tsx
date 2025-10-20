import * as React from 'react';
import { View, Pressable, TextInput, KeyboardAvoidingView, Platform, Linking, Keyboard } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Mail, ArrowRight, ChevronLeft } from 'lucide-react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Svg, { Path, G, ClipPath, Defs, Rect } from 'react-native-svg';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AuthDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * AuthDrawer Component
 * 
 * Beautiful bottom drawer for authentication
 * Matches ChatInput and app design system
 * 
 * Features:
 * - Continue with Apple (OAuth)
 * - Continue with Google (OAuth)
 * - Sign in with email
 * - Elegant animations
 * - Design system colors
 */
  export const AuthDrawer = React.forwardRef<BottomSheetModal, AuthDrawerProps>(
    ({ isOpen, onClose }, ref) => {
    const { t } = useLanguage();
    const { colorScheme } = useColorScheme();
    const { signInWithOAuth } = useAuth();
    const [showEmailForm, setShowEmailForm] = React.useState(false);
    const [showForgotPassword, setShowForgotPassword] = React.useState(false);
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');

    const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;

    // Dynamic snap point - changes based on input focus
    const [isInputFocused, setIsInputFocused] = React.useState(false);
    const snapPoints = React.useMemo(() => [isInputFocused ? '90%' : '50%'], [isInputFocused]);
    const emailInputRef = React.useRef<TextInput | null>(null);

    // Handle keyboard visibility - only shrink when keyboard hides
    React.useEffect(() => {
      const keyboardDidHideListener = Keyboard.addListener(
        'keyboardDidHide',
        () => {
      // Shrink drawer when keyboard hides and not on email form
      if (!showEmailForm) {
        setIsInputFocused(false);
      }
        }
      );

      return () => {
        keyboardDidHideListener.remove();
      };
    }, [ref, showEmailForm]);

    const renderBackdrop = React.useCallback(
      (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop
          {...props}
          disappearsOnIndex={-1}
          appearsOnIndex={0}
          opacity={0.5}
          pressBehavior="close"
          onPress={() => {
            console.log('📊 Backdrop pressed, dismissing keyboard');
            Keyboard.dismiss();
          }}
        />
      ),
      []
    );

    const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
      console.log('🎯 OAuth sign in:', provider);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      
      const result = await signInWithOAuth(provider);
      
      console.log('📊 OAuth result:', result);
      
      if (result.success) {
        console.log('✅ OAuth successful, closing drawer');
        onClose();
      } else {
        console.error('❌ OAuth failed:', result.error);
        // Error is already handled in useAuth hook
      }
    };

    const handleEmailAuth = () => {
      console.log('🎯 Show email form');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setShowEmailForm(true);
      // Auto-focus email input after transition
      setTimeout(() => {
        emailInputRef.current?.focus();
      }, 300);
    };

    const handleBackFromEmail = () => {
      console.log('🎯 Back from email form');
      Keyboard.dismiss();
      setShowEmailForm(false);
      setShowForgotPassword(false);
      setIsInputFocused(false);
    };

    const handleShowForgotPassword = () => {
      console.log('🎯 Show forgot password form');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setShowForgotPassword(true);
    };

    const handleBackFromForgotPassword = () => {
      console.log('🎯 Back from forgot password');
      setShowForgotPassword(false);
    };

    // Handle input focus - expand drawer when input is focused
    const handleInputFocus = () => {
      console.log('🎯 Input focused, changing max height to 90%');
      setIsInputFocused(true);
    };

    // Handle input blur - collapse drawer when no input is focused
    const handleInputBlur = () => {
      console.log('📊 Input blurred, checking focus state');
      // Check if any input is still focused after a small delay
      setTimeout(() => {
        if (!TextInput.State.currentlyFocusedInput()) {
          console.log('📊 No input focused, changing max height to 60%');
          setIsInputFocused(false);
        }
      }, 100);
    };

    // Handle drawer close - dismiss keyboard first
    const handleDismiss = () => {
      console.log('🔐 Auth drawer closing, dismissing keyboard');
      Keyboard.dismiss();
      setIsInputFocused(false);
      onClose();
    };

    // Handle drawer changes - dismiss keyboard when dragging down
    const handleSheetChange = React.useCallback((index: number) => {
      console.log('📊 Drawer index:', index);
      if (index === -1) {
        // Drawer is closing
        Keyboard.dismiss();
      }
    }, []);

    return (
      <BottomSheetModal
        ref={ref}
        index={0}
        snapPoints={snapPoints}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        onDismiss={handleDismiss}
        enableDynamicSizing={false}
        animateOnMount={true}
        backgroundStyle={{
          backgroundColor: colorScheme === 'dark' ? '#121215' : '#F8F8F8',
        }}
        handleIndicatorStyle={{
          backgroundColor: colorScheme === 'dark' ? '#232324' : '#DCDCDC',
          width: 40,
          height: 4,
        }}
      >
        <BottomSheetView style={{ flex: 1 }}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
          >
            <View className="flex-1">
              {/* Main Content */}
              <View className="flex-1 px-6 pt-8 pb-20">
                {/* Logo - Only show on main screen */}
                {!showEmailForm && !showForgotPassword && (
                  <View className="items-center mb-8">
                    <Logomark width={224} height={44} />
                  </View>
                )}

                {!showEmailForm && !showForgotPassword ? (
                  <>
                    {/* Title */}
                    <Text className="text-[15px] font-roobert text-muted-foreground text-center mb-8 px-4">
                      {t('auth.createFreeAccount')}
                    </Text>

                    {/* Auth Buttons */}
                    <View className="gap-3">
                      <AppleSignInButton
                        onPress={() => handleOAuthSignIn('apple')}
                        label={t('auth.continueWithApple')}
                      />
                      <GoogleSignInButton
                        onPress={() => handleOAuthSignIn('google')}
                        label={t('auth.continueWithGoogle')}
                      />
                      <EmailSignInButton
                        onPress={handleEmailAuth}
                        label={t('auth.signInWithEmail')}
                      />
                    </View>
                  </>
                ) : showForgotPassword ? (
                  <ForgotPasswordForm
                    email={email}
                    setEmail={setEmail}
                    onBack={handleBackFromForgotPassword}
                    onClose={onClose}
                    emailInputRef={emailInputRef}
                    onInputFocus={handleInputFocus}
                    onInputBlur={handleInputBlur}
                    t={t}
                  />
                ) : (
                  <EmailAuthForm
                    email={email}
                    setEmail={setEmail}
                    password={password}
                    setPassword={setPassword}
                    onBack={handleBackFromEmail}
                    onForgotPassword={handleShowForgotPassword}
                    onClose={onClose}
                    emailInputRef={emailInputRef}
                    onInputFocus={handleInputFocus}
                    onInputBlur={handleInputBlur}
                    t={t}
                  />
                )}
              </View>

              {/* Footer - Privacy & Terms - Fixed at bottom */}
              {/* <View 
                className="left-0 right-0 items-center"

              >
                <Pressable onPress={() => Linking.openURL('https://kortix.ai/legal')}>
                  <Text className="text-xs font-roobert-medium text-muted-foreground">
                  Terms of Service & Privacy Policy
                  </Text>
                </Pressable>
              </View> */}

            </View>
          </KeyboardAvoidingView>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

AuthDrawer.displayName = 'AuthDrawer';

/**
 * Apple Sign In Button
 * Follows Apple's Human Interface Guidelines
 * https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
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
 * Uses standard Google branding colors
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
 * Multi-color G logo using react-native-svg
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
 * Third option for email authentication
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

/**
 * Email Auth Form Component
 */
interface EmailAuthFormProps {
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  onBack: () => void;
  onForgotPassword: () => void;
  onClose: () => void;
  emailInputRef: React.RefObject<TextInput | null>;
  onInputFocus: () => void;
  onInputBlur: () => void;
  t: (key: string, options?: any) => string;
}

function EmailAuthForm({
  email,
  setEmail,
  password,
  setPassword,
  onBack,
  onForgotPassword,
  onClose,
  emailInputRef,
  onInputFocus,
  onInputBlur,
  t,
}: EmailAuthFormProps) {
  const { signIn, isLoading } = useAuth();
  const [error, setError] = React.useState('');
  const passwordInputRef = React.useRef<TextInput>(null);

  const handleSignIn = async () => {
    if (!email || !password) {
      setError(t('auth.enterEmailPassword'));
      return;
    }

    console.log('🎯 Email sign in attempt:', email);
    const result = await signIn({ email, password });

    if (result.success) {
      console.log('✅ Sign in successful');
      onClose();
    } else {
      console.log('❌ Sign in failed:', result.error);
      setError(result.error?.message || t('auth.signInFailed'));
    }
  };

  return (
    <View>
      {/* Back Button - Top Left Corner */}
      <Pressable 
        onPress={onBack} 
        className="absolute top-0 left-0 size-10 justify-center z-10"
        style={{ paddingLeft: 0 }}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Icon as={ChevronLeft} size={24} className="text-foreground" />
      </Pressable>

      <View className="mt-16">
        <Text className="text-2xl font-roobert-semibold text-foreground mb-8">
          {t('auth.signInWithEmail')}
        </Text>

          {/* Email Input */}
        <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-3">
        <TextInput
          ref={emailInputRef}
          value={email}
          onChangeText={setEmail}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('auth.emailPlaceholder')}
          placeholderTextColor="hsl(var(--muted-foreground))"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
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
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('auth.passwordPlaceholder')}
          placeholderTextColor="hsl(var(--muted-foreground))"
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
          <Text className="text-destructive text-sm font-roobert mb-4">
            {error}
          </Text>
        )}

        {/* Sign In Button */}
        <Pressable
        onPress={handleSignIn}
        disabled={isLoading}
        className="bg-primary h-12 rounded-2xl flex-row items-center justify-center gap-2"
      >
        <Text className="text-[15px] font-roobert-medium text-primary-foreground">
          {isLoading ? t('auth.signingIn') : t('auth.signIn')}
        </Text>
        {!isLoading && (
          <Icon as={ArrowRight} size={16} className="text-primary-foreground" />
        )}
      </Pressable>

        {/* Forgot Password */}
        <Pressable onPress={onForgotPassword} className="mt-6">
          <Text className="text-[14px] font-roobert-medium text-muted-foreground text-center">
            {t('auth.forgotPassword')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Forgot Password Form Component
 */
interface ForgotPasswordFormProps {
  email: string;
  setEmail: (email: string) => void;
  onBack: () => void;
  onClose: () => void;
  emailInputRef: React.RefObject<TextInput | null>;
  onInputFocus: () => void;
  onInputBlur: () => void;
  t: (key: string, options?: any) => string;
}

function ForgotPasswordForm({
  email,
  setEmail,
  onBack,
  onClose,
  emailInputRef,
  onInputFocus,
  onInputBlur,
  t,
}: ForgotPasswordFormProps) {
  const { resetPassword } = useAuth();
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [isSuccess, setIsSuccess] = React.useState(false);

  const handleResetPassword = async () => {
    if (!email) {
      setError(t('auth.enterEmailAddress'));
      return;
    }

    console.log('🎯 Password reset request:', email);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsLoading(true);
    setError('');
    
    const result = await resetPassword({ email });

    setIsLoading(false);

    if (result.success) {
      console.log('✅ Password reset email sent');
      setIsSuccess(true);
    } else {
      console.log('❌ Password reset failed:', result.error);
      setError(result.error?.message || t('auth.resetFailed'));
    }
  };

  if (isSuccess) {
    return (
      <>
        {/* Success State */}
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
          onPress={onBack}
          className="bg-primary h-12 rounded-2xl flex-row items-center justify-center gap-2"
        >
          <Text className="text-[15px] font-roobert-medium text-primary-foreground">
            {t('auth.backToSignIn')}
          </Text>
        </Pressable>

        {/* Resend Link */}
        <Pressable onPress={() => setIsSuccess(false)} className="mt-6">
          <Text className="text-[14px] font-roobert-medium text-muted-foreground text-center">
            {t('auth.didntReceiveEmail')}
          </Text>
        </Pressable>
      </>
    );
  }

  return (
    <View>
      {/* Back Button - Top Left Corner */}
      <Pressable 
        onPress={onBack} 
        className="absolute top-0 left-0 size-10 justify-center z-10"
        style={{ paddingLeft: 0 }}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Icon as={ChevronLeft} size={24} className="text-foreground" />
      </Pressable>

      <View className="mt-16">
        <Text className="text-2xl font-roobert-semibold text-foreground mb-2">
          {t('auth.resetPassword')}
        </Text>
      
        <Text className="text-[15px] font-roobert text-muted-foreground mb-8">
          {t('auth.resetPasswordDescription')}
        </Text>

        {/* Email Input */}
        <View className="bg-card border border-border rounded-2xl h-12 px-4 mb-4">
        <TextInput
          ref={emailInputRef}
          value={email}
          onChangeText={setEmail}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          placeholder={t('auth.emailPlaceholder')}
          placeholderTextColor="hsl(var(--muted-foreground))"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={handleResetPassword}
          style={{ fontFamily: 'Roobert-Regular' }}
          className="flex-1 text-foreground text-[15px]"
        />
        </View>

        {/* Error Message */}
        {error && (
          <Text className="text-destructive text-sm font-roobert mb-4">
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
    </View>
  );
}

