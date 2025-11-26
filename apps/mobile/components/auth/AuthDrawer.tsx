import * as React from 'react';
import { View, Pressable, TextInput, KeyboardAvoidingView, Platform, Keyboard, TouchableOpacity } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import Animated, { 
  FadeIn,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mail, ArrowRight, X, Check } from 'lucide-react-native';
import { FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';
import { openInbox } from 'react-native-email-link';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';

const AnimatedView = Animated.createAnimatedComponent(View);

/**
 * AuthDrawer Component
 * 
 * Beautiful bottom drawer for authentication
 * Uses old structure with new modern styling
 */
export function AuthDrawer() {
  const { isOpen, closeAuthDrawer, onSuccess, title: storeTitle, message: storeMessage, mode: storeMode } = useAuthDrawerStore();
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);

  React.useEffect(() => {
    if (isOpen) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [isOpen]);

  const handleClose = () => {
    closeAuthDrawer();
    if (onSuccess) {
      onSuccess();
    }
  };

  return (
    <AuthDrawerContent
      ref={bottomSheetRef}
      isOpen={isOpen}
      onClose={handleClose}
      title={storeTitle}
      message={storeMessage}
      initialMode={storeMode}
    />
  );
}

const AuthDrawerContent = React.forwardRef<BottomSheetModal, { 
  isOpen: boolean; 
  onClose: () => void;
  title?: string;
  message?: string;
  initialMode?: 'choose' | 'email-auth' | 'sign-in' | 'sign-up';
}>(
  ({ isOpen, onClose, title: propTitle, message: propMessage, initialMode }, ref) => {
    const { t } = useLanguage();
    const { colorScheme } = useColorScheme();
    const { signInWithOAuth, signInWithMagicLink, isLoading } = useAuth();
    const [showEmailForm, setShowEmailForm] = React.useState(false);
    const [emailSent, setEmailSent] = React.useState(false);
    const [email, setEmail] = React.useState('');
    const [acceptedTerms, setAcceptedTerms] = React.useState(false);

    const isDark = colorScheme === 'dark';
    const title = propTitle || t('auth.drawer.defaultTitle');
    const message = propMessage || t('auth.drawer.defaultMessage');

    // Dynamic snap point - changes based on input focus
    const [isInputFocused, setIsInputFocused] = React.useState(false);
    const snapPoints = React.useMemo(() => [isInputFocused ? '90%' : '60%'], [isInputFocused]);
    const emailInputRef = React.useRef<TextInput | null>(null);
    const [error, setError] = React.useState('');

    // Auto-open email form when mode is 'email-auth'
    React.useEffect(() => {
      if (isOpen && initialMode === 'email-auth' && !showEmailForm) {
        setShowEmailForm(true);
        setIsInputFocused(true);
        setTimeout(() => {
          emailInputRef.current?.focus();
        }, 400);
      }
    }, [isOpen, initialMode, showEmailForm]);

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
    }, [showEmailForm]);

    const renderBackdrop = React.useCallback(
      (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop
          {...props}
          disappearsOnIndex={-1}
          appearsOnIndex={0}
          opacity={0.5}
          pressBehavior="close"
          onPress={() => {
            Keyboard.dismiss();
          }}
        />
      ),
      []
    );

    const handleOAuthSignIn = async (provider: 'apple' | 'google') => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await signInWithOAuth(provider);
      
      if (result.success) {
        onClose();
      }
    };

    const handleEmailAuth = () => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setShowEmailForm(true);
      setEmailSent(false);
      setIsInputFocused(true);
      setTimeout(() => {
        emailInputRef.current?.focus();
      }, 300);
    };

    const handleSendMagicLink = async () => {
      if (!email || !email.includes('@')) {
        setError(t('auth.validationErrors.emailRequired') || 'Please enter a valid email');
        return;
      }

      if (!acceptedTerms) {
        setError(t('auth.termsRequired'));
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setError('');
      
      const result = await signInWithMagicLink({ email, acceptedTerms });
      
      if (result.success) {
        setEmailSent(true);
        Keyboard.dismiss();
      } else {
        setError(result.error?.message || t('auth.magicLinkFailed'));
      }
    };

    const handleBackFromEmail = () => {
      Keyboard.dismiss();
      setShowEmailForm(false);
      setEmailSent(false);
      setIsInputFocused(false);
      setEmail('');
      setError('');
    };

    // Handle input focus - expand drawer when input is focused
    const handleInputFocus = () => {
      setIsInputFocused(true);
    };

    // Handle input blur - collapse drawer when no input is focused
    const handleInputBlur = () => {
      setTimeout(() => {
        if (!TextInput.State.currentlyFocusedInput()) {
          setIsInputFocused(false);
        }
      }, 100);
    };

    // Handle drawer close - dismiss keyboard first
    const handleDismiss = () => {
      Keyboard.dismiss();
      setIsInputFocused(false);
      onClose();
    };

    // Handle drawer changes - dismiss keyboard when dragging down
    const handleSheetChange = React.useCallback((index: number) => {
      if (index === -1) {
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
          backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
        }}
      >
        <BottomSheetView style={{ flex: 1 }}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
          >
            <View className="flex-1 px-6 pt-6 pb-20">
              {!showEmailForm ? (
                <View className="gap-8">
                  {/* Title */}
                  <View className="gap-4">
                    <Text className="text-2xl font-roobert-semibold text-foreground leading-tight">
                      {title}
                    </Text>
                    {message && (
                      <Text className="text-sm text-muted-foreground leading-relaxed">
                        {message}
                      </Text>
                    )}
                  </View>

                  {/* Auth Buttons */}
                  <View className="gap-4">
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
                </View>
              ) : (
                <EmailAuthForm
                  email={email}
                  setEmail={setEmail}
                  emailSent={emailSent}
                  acceptedTerms={acceptedTerms}
                  setAcceptedTerms={setAcceptedTerms}
                  onBack={handleBackFromEmail}
                  onSendMagicLink={handleSendMagicLink}
                  onClose={onClose}
                  emailInputRef={emailInputRef}
                  onInputFocus={handleInputFocus}
                  onInputBlur={handleInputBlur}
                  t={t}
                  error={error}
                  isLoading={isLoading}
                  isDark={isDark}
                />
              )}
            </View>
          </KeyboardAvoidingView>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

AuthDrawerContent.displayName = 'AuthDrawerContent';

/**
 * Apple Sign In Button
 */
interface AppleSignInButtonProps {
  onPress: () => void;
  label: string;
}

function AppleSignInButton({ onPress, label }: AppleSignInButtonProps) {
  return (
    <Button
      variant="default"
      size="lg"
      onPress={onPress}
      className="bg-[#000000]"
    >
      <FontAwesome5 name="apple" size={20} color="white" />
      <Text className="text-[16px] font-roobert-medium text-white">
        {label}
      </Text>
    </Button>
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
  return (
    <Button
      variant="outline"
      size="lg"
      onPress={onPress}
      className="bg-white border border-[#dadce0]"
    >
      <GoogleLogo />
      <Text className="text-[16px] font-roobert-medium text-[#1f1f1f]">
        {label}
      </Text>
    </Button>
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
  return (
    <Button
      variant="outline"
      size="lg"
      onPress={onPress}
    >
                    <Icon as={Mail} size={20} className="text-foreground" />
      <Text className="text-[16px] font-roobert-medium text-foreground">
        {label}
                    </Text>
    </Button>
  );
}

/**
 * Email Auth Form Component - Passwordless (Magic Link)
 */
interface EmailAuthFormProps {
  email: string;
  setEmail: (email: string) => void;
  emailSent: boolean;
  acceptedTerms: boolean;
  setAcceptedTerms: (accepted: boolean) => void;
  onBack: () => void;
  onSendMagicLink: () => Promise<void>;
  onClose: () => void;
  emailInputRef: React.RefObject<TextInput | null>;
  onInputFocus: () => void;
  onInputBlur: () => void;
  t: (key: string, options?: any) => string;
  error: string;
  isLoading: boolean;
  isDark: boolean;
}

function EmailAuthForm({
  email,
  setEmail,
  emailSent,
  acceptedTerms,
  setAcceptedTerms,
  onBack,
  onSendMagicLink,
  onClose,
  emailInputRef,
  onInputFocus,
  onInputBlur,
  t,
  error,
  isLoading,
  isDark,
}: EmailAuthFormProps) {
  const isValidEmail = email.includes('@') && email.length > 3;

  // Show success state after email is sent
  if (emailSent) {
    return (
            <View className="gap-6">
        {/* Header */}
        <View className="flex-row items-center justify-between">
                <TouchableOpacity
            onPress={onBack}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text className="text-muted-foreground text-[16px] font-roobert">
                    {t('common.back')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
            onPress={onClose}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={X} size={24} className="text-muted-foreground" />
                </TouchableOpacity>
              </View>

        {/* Success State */}
        <View className="items-center gap-5">
          <View className="size-16 rounded-full bg-primary/10 items-center justify-center">
            <Icon as={Mail} size={32} className="text-primary" />
          </View>
          
          <View className="gap-3">
            <Text className="text-2xl font-roobert-semibold text-foreground text-center">
              {t('auth.checkYourEmail')}
            </Text>
            
            <Text className="text-[15px] font-roobert text-muted-foreground text-center px-4">
              {t('auth.magicLinkSent')}{'\n\n'}
              <Text className="font-roobert-medium text-foreground">{email}</Text>
            </Text>
          </View>
        </View>

        {/* Email App Buttons */}
        <View className="w-full gap-3">
          {Platform.OS === 'ios' && (
            <Button
              variant="outline"
              size="default"
              onPress={async () => {
                try {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  await openInbox({});
                } catch (error) {
                  console.error('Failed to open email app:', error);
                }
              }}
              className="flex-row items-center justify-center gap-2"
            >
              <Icon as={Mail} size={18} className="text-foreground" strokeWidth={2.5} />
              <Text className="text-foreground text-[15px] font-roobert-medium">
                {t('auth.openEmailAppBtn')}
              </Text>
            </Button>
          )}
          
          <Button
            variant="outline"
            size="default"
            onPress={async () => {
              try {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                await openInbox({ app: 'gmail' });
              } catch (error) {
                console.error('Failed to open Gmail:', error);
              }
            }}
            className="flex-row items-center justify-center gap-2"
          >
            <MaterialCommunityIcons 
              name="gmail" 
              size={20} 
              color={isDark ? '#FFFFFF' : '#000000'} 
            />
            <Text className="text-foreground text-[15px] font-roobert-medium">
              {t('auth.openGmailBtn')}
                  </Text>
          </Button>

          {/* Resend Link */}
          <Button
            variant="ghost"
            size="default"
            onPress={async () => {
              await onSendMagicLink();
                  }}
            disabled={isLoading}
            className="flex-row items-center justify-center gap-2"
                >
            <Text className="text-muted-foreground text-[15px] font-roobert">
              {isLoading ? t('auth.sending') : t('auth.resendLink')}
                  </Text>
          </Button>
              </View>
            </View>
    );
  }

  return (
    <View className="gap-6">
      {/* Header */}
      <View className="flex-row items-center justify-between">
                <TouchableOpacity
          onPress={onBack}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Text className="text-muted-foreground text-[16px] font-roobert">
                    {t('common.back')}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
          onPress={onClose}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Icon as={X} size={24} className="text-muted-foreground" />
                </TouchableOpacity>
              </View>

      {/* Title */}
      <View className="gap-4">
        <Text className="text-[28px] font-roobert-semibold text-foreground leading-tight">
          {t('auth.continueWithEmail')}
        </Text>
        <Text className="text-[15px] font-roobert text-muted-foreground">
          {t('auth.magicLinkDescription')}
                  </Text>
      </View>

      {/* Email Input */}
      <Input
        ref={emailInputRef}
        value={email}
        onChangeText={(text) => {
          setEmail(text.trim().toLowerCase());
        }}
        onFocus={onInputFocus}
        onBlur={onInputBlur}
        placeholder={t('auth.emailPlaceholder')}
        keyboardType="email-address"
        returnKeyType="go"
        onSubmitEditing={onSendMagicLink}
        size="lg"
        wrapperClassName="bg-muted/10 dark:bg-muted/30"
      />

      {/* Error Message */}
      {error && (
        <AnimatedView entering={FadeIn.duration(200)}>
          <Text className="text-destructive text-[14px] font-roobert text-center">
            {error}
                  </Text>
        </AnimatedView>
      )}

      {/* Terms Checkbox */}
      <View className="flex-row items-start">
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
          <TouchableOpacity onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const WebBrowser = await import('expo-web-browser');
            await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=terms', {
              presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
              controlsColor: isDark ? '#FFFFFF' : '#000000',
            });
          }}>
            <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
              {t('auth.userTerms')}
            </Text>
          </TouchableOpacity>
            <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
              {' '}{t('auth.and')}{' '}
            </Text>
          <TouchableOpacity onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const WebBrowser = await import('expo-web-browser');
            await WebBrowser.openBrowserAsync('https://www.kortix.com/legal?tab=privacy', {
              presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
              controlsColor: isDark ? '#FFFFFF' : '#000000',
            });
          }}>
            <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
              {t('auth.privacyNotice')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Send Magic Link Button */}
      <Button
        variant="default"
        size="lg"
        onPress={onSendMagicLink}
        disabled={isLoading || !isValidEmail || !acceptedTerms}
      >
        <Text className="text-[16px] font-roobert-medium text-primary-foreground">
          {isLoading ? t('auth.sending') : t('auth.sendMagicLink')}
        </Text>
        {!isLoading && (
          <Icon as={ArrowRight} size={16} className="text-primary-foreground" />
        )}
      </Button>
    </View>
  );
}

