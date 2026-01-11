import * as React from 'react';
import { View, TextInput, Keyboard, Platform } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView, BottomSheetBackdrop, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mail, ArrowRight, X, Check } from 'lucide-react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { openInbox } from 'react-native-email-link';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { useToast } from '@/components/ui/toast-provider';
import { log } from '@/lib/logger';

export interface EmailAuthDrawerRef {
  open: () => void;
  close: () => void;
}

/**
 * EmailAuthDrawer Component
 * 
 * Simple bottom drawer for email/magic link authentication.
 * Controlled via ref - no global store needed.
 */
export const EmailAuthDrawer = React.forwardRef<EmailAuthDrawerRef, {
  onSuccess?: () => void;
}>(({ onSuccess }, ref) => {
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { signInWithMagicLink, isLoading } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  
  const [emailSent, setEmailSent] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [acceptedTerms, setAcceptedTerms] = React.useState(false);
  const [isInputFocused, setIsInputFocused] = React.useState(false);
  const emailInputRef = React.useRef<TextInput | null>(null);

  const isDark = colorScheme === 'dark';

  // Expose open/close methods via ref
  React.useImperativeHandle(ref, () => ({
    open: () => {
      bottomSheetRef.current?.present();
      setIsInputFocused(true);
      setTimeout(() => {
        emailInputRef.current?.focus();
      }, 400);
    },
    close: () => {
      bottomSheetRef.current?.dismiss();
    },
  }));

  // Dynamic snap point based on state - always 85% height
  const snapPoints = React.useMemo(() => {
    return ['90%'];
  }, []);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
        onPress={() => Keyboard.dismiss()}
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

  const handleDismiss = () => {
    Keyboard.dismiss();
    // Reset state for next open
    setEmailSent(false);
    setEmail('');
    setAcceptedTerms(false);
    setIsInputFocused(false);
  };

  const handleSheetChange = React.useCallback((index: number) => {
    if (index === -1) {
      Keyboard.dismiss();
    }
  }, []);

  const isValidEmail = email.includes('@') && email.length > 3;

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      index={0}
      snapPoints={snapPoints}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      onDismiss={handleDismiss}
      enableDynamicSizing={false}
      animateOnMount={true}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={{
        backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
      }}
      handleIndicatorStyle={{
        backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
      }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 24,
          paddingBottom: Math.max(insets.bottom, 20) + 16,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View className="flex-1">
            {emailSent ? (
              // Success State
              <View className="gap-6">
                <View className="flex-row items-center justify-end">
                  <BottomSheetTouchable
                    onPress={() => bottomSheetRef.current?.dismiss()}
                  >
                    <Icon as={X} size={24} className="text-muted-foreground" />
                  </BottomSheetTouchable>
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
                          log.error('Failed to open email app:', error);
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
                        log.error('Failed to open Gmail:', error);
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
                  <BottomSheetTouchable
                    onPress={() => bottomSheetRef.current?.dismiss()}
                  >
                    <Icon as={X} size={24} className="text-muted-foreground" />
                  </BottomSheetTouchable>
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
                  onChangeText={(text) => setEmail(text.trim().toLowerCase())}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => {
                    setTimeout(() => {
                      if (!TextInput.State.currentlyFocusedInput()) {
                        setIsInputFocused(false);
                      }
                    }, 100);
                  }}
                  placeholder={t('auth.emailPlaceholder')}
                  keyboardType="email-address"
                  returnKeyType="go"
                  onSubmitEditing={handleSendMagicLink}
                  size="lg"
                  wrapperClassName="bg-muted/10 dark:bg-muted/30"
                />

                <View className="flex-row items-start">
                  <BottomSheetTouchable
                    onPress={() => {
                      setAcceptedTerms(!acceptedTerms);
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={{ marginRight: 12, marginTop: 2 }}
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
                  </BottomSheetTouchable>

                  <View className="flex-1 flex-row flex-wrap">
                    <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
                      {t('auth.agreeTerms')}{' '}
                    </Text>
                    <BottomSheetTouchable onPress={async () => {
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
                    </BottomSheetTouchable>
                    <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
                      {' '}{t('auth.and')}{' '}
                    </Text>
                    <BottomSheetTouchable onPress={async () => {
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
                    </BottomSheetTouchable>
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
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});

EmailAuthDrawer.displayName = 'EmailAuthDrawer';
