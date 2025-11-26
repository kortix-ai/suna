import * as React from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform, Keyboard, TouchableOpacity } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mail, ArrowRight, X, Check } from 'lucide-react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { openInbox } from 'react-native-email-link';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage, useAuthContext } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { useAuthDrawerStore } from '@/stores/auth-drawer-store';
import { useToast } from '@/components/ui/toast-provider';

/**
 * EmailAuthDrawer Component
 * 
 * Bottom drawer for email/magic link authentication only.
 * Opens directly to email form - no provider selection.
 */
export function EmailAuthDrawer() {
  const { isOpen, closeAuthDrawer, onSuccess, message: storeMessage } = useAuthDrawerStore();
  const { isAuthenticated } = useAuthContext();
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const wasAuthenticatedRef = React.useRef(isAuthenticated);

  React.useEffect(() => {
    if (isOpen) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [isOpen]);

  // Close drawer when user becomes authenticated
  React.useEffect(() => {
    const wasAuthenticated = wasAuthenticatedRef.current;
    const nowAuthenticated = isAuthenticated;

    // Only act on authentication state CHANGE (false -> true)
    if (!wasAuthenticated && nowAuthenticated && isOpen) {
      console.log('🚪 Closing email auth drawer - user just authenticated');
      closeAuthDrawer();
      if (onSuccess) {
        onSuccess();
      }
    }

    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated, isOpen, closeAuthDrawer, onSuccess]);

  const handleClose = () => {
    closeAuthDrawer();
  };

  return (
    <EmailAuthDrawerContent
      ref={bottomSheetRef}
      isOpen={isOpen}
      onClose={handleClose}
      errorMessage={storeMessage}
    />
  );
}

const EmailAuthDrawerContent = React.forwardRef<BottomSheetModal, { 
  isOpen: boolean; 
  onClose: () => void;
  errorMessage?: string;
}>(
  ({ isOpen, onClose, errorMessage }, ref) => {
    const { t } = useLanguage();
    const { colorScheme } = useColorScheme();
    const { signInWithMagicLink, isLoading } = useAuth();
    const toast = useToast();
    
    const [emailSent, setEmailSent] = React.useState(false);
    const [email, setEmail] = React.useState('');
    const [acceptedTerms, setAcceptedTerms] = React.useState(false);
    const [isInputFocused, setIsInputFocused] = React.useState(false);
    const emailInputRef = React.useRef<TextInput | null>(null);
    const shownErrorRef = React.useRef<string | null>(null);

    const isDark = colorScheme === 'dark';

    // Dynamic snap point based on input focus and email sent state
    const snapPoints = React.useMemo(() => {
      if (emailSent) {
        return ['70%']; // Taller for success state with buttons
      }
      return [isInputFocused ? '85%' : '55%'];
    }, [isInputFocused, emailSent]);

    // Handle drawer open/close state changes
    const { isAuthenticated: authIsAuthenticated } = useAuthContext();
    const prevIsOpenRef = React.useRef(isOpen);
    
    React.useEffect(() => {
      const wasOpen = prevIsOpenRef.current;
      const nowOpen = isOpen;
      
      // Drawer just opened
      if (!wasOpen && nowOpen) {
        setIsInputFocused(true);
        setTimeout(() => {
          emailInputRef.current?.focus();
        }, 400);
        
        // Show error toast if there's a message
        if (errorMessage && shownErrorRef.current !== errorMessage) {
          setEmailSent(false);
          toast.error(errorMessage);
          shownErrorRef.current = errorMessage;
        }
      }
      
      // Drawer just closed
      if (wasOpen && !nowOpen && !authIsAuthenticated) {
        setEmailSent(false);
        setEmail('');
        setAcceptedTerms(false);
        setIsInputFocused(false);
        shownErrorRef.current = null;
        Keyboard.dismiss();
      }
      
      prevIsOpenRef.current = isOpen;
    }, [isOpen, errorMessage, authIsAuthenticated, toast]);

    // Handle keyboard visibility
    React.useEffect(() => {
      const keyboardDidHideListener = Keyboard.addListener(
        'keyboardDidHide',
        () => {
          setIsInputFocused(false);
        }
      );

      return () => {
        keyboardDidHideListener.remove();
      };
    }, []);

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

    const handleSendMagicLink = async () => {
      if (!email || !email.includes('@')) {
        toast.error(t('auth.validationErrors.emailRequired'));
        return;
      }

      if (!acceptedTerms) {
        toast.error(t('auth.termsRequired'));
        return;
      }

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      
      const result = await signInWithMagicLink({ email, acceptedTerms });
      
      if (result.success) {
        setEmailSent(true);
        setIsInputFocused(false);
        Keyboard.dismiss();
        emailInputRef.current?.blur();
      } else {
        toast.error(result.error?.message || t('auth.magicLinkFailed'));
      }
    };

    const handleInputFocus = () => {
      setIsInputFocused(true);
    };

    const handleInputBlur = () => {
      setTimeout(() => {
        if (!TextInput.State.currentlyFocusedInput()) {
          setIsInputFocused(false);
        }
      }, 100);
    };

    const handleDismiss = () => {
      Keyboard.dismiss();
      setIsInputFocused(false);
      setEmailSent(false);
      setEmail('');
      setAcceptedTerms(false);
      onClose();
    };

    const handleSheetChange = React.useCallback((index: number) => {
      if (index === -1) {
        Keyboard.dismiss();
      }
    }, []);

    const isValidEmail = email.includes('@') && email.length > 3;

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
              {emailSent ? (
                // Success State
                <View className="gap-6">
                  <View className="flex-row items-center justify-end">
                    <TouchableOpacity
                      onPress={onClose}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Icon as={X} size={24} className="text-muted-foreground" />
                    </TouchableOpacity>
                  </View>

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

                  <View className="w-full gap-3">
                    {Platform.OS === 'ios' && (
                      <Button
                        variant="outline"
                        size="lg"
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
                        <Icon as={Mail} size={20} className="text-foreground" strokeWidth={2.5} />
                        <Text className="text-foreground text-[16px] font-roobert-medium">
                          {t('auth.openEmailAppBtn')}
                        </Text>
                      </Button>
                    )}
                    
                    <Button
                      variant="outline"
                      size="lg"
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
                        size={22} 
                        color={isDark ? '#FFFFFF' : '#000000'} 
                      />
                      <Text className="text-foreground text-[16px] font-roobert-medium">
                        {t('auth.openGmailBtn')}
                      </Text>
                    </Button>

                    <Button
                      variant="ghost"
                      size="lg"
                      onPress={handleSendMagicLink}
                      disabled={isLoading}
                      className="flex-row items-center justify-center gap-2"
                    >
                      <Text className="text-muted-foreground text-[16px] font-roobert">
                        {isLoading ? t('auth.sending') : t('auth.resendLink')}
                      </Text>
                    </Button>
                  </View>
                </View>
              ) : (
                // Email Form
                <View className="gap-6">
                  <View className="flex-row items-center justify-end">
                    <TouchableOpacity
                      onPress={onClose}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Icon as={X} size={24} className="text-muted-foreground" />
                    </TouchableOpacity>
                  </View>

                  <View className="gap-4">
                    <Text className="text-[28px] font-roobert-semibold text-foreground leading-tight">
                      {t('auth.continueWithEmail')}
                    </Text>
                    <Text className="text-[15px] font-roobert text-muted-foreground">
                      {t('auth.magicLinkDescription')}
                    </Text>
                  </View>

                  <Input
                    ref={emailInputRef}
                    value={email}
                    onChangeText={(text) => {
                      setEmail(text.trim().toLowerCase());
                    }}
                    onFocus={handleInputFocus}
                    onBlur={handleInputBlur}
                    placeholder={t('auth.emailPlaceholder')}
                    keyboardType="email-address"
                    returnKeyType="go"
                    onSubmitEditing={handleSendMagicLink}
                    size="lg"
                    wrapperClassName="bg-muted/10 dark:bg-muted/30"
                  />

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

                  <Button
                    variant="default"
                    size="lg"
                    onPress={handleSendMagicLink}
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
              )}
            </View>
          </KeyboardAvoidingView>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

EmailAuthDrawerContent.displayName = 'EmailAuthDrawerContent';

