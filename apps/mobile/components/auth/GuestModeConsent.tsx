import * as React from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Shield } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import BottomSheet, { BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { useLanguage } from '@/contexts';

const AnimatedPressable = Animated.createAnimatedComponent(TouchableOpacity);

interface GuestModeConsentProps {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onDismiss?: () => void;
}

export function GuestModeConsent({ visible, onAccept, onDecline, onDismiss }: GuestModeConsentProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const { t } = useLanguage();

  const scale1 = useSharedValue(1);
  const scale2 = useSharedValue(1);

  const animatedStyle1 = useAnimatedStyle(() => ({
    transform: [{ scale: scale1.value }],
  }));

  const animatedStyle2 = useAnimatedStyle(() => ({
    transform: [{ scale: scale2.value }],
  }));

  React.useEffect(() => {
    if (visible) {
      setTimeout(() => {
        bottomSheetRef.current?.snapToIndex(0);
      }, 100);
    } else {
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleAccept = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    bottomSheetRef.current?.close();
    setTimeout(() => {
      onAccept();
    }, 300);
  };

  const handleDecline = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    bottomSheetRef.current?.close();
    setTimeout(() => {
      onDecline();
    }, 300);
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
      snapPoints={['70%']}
      enablePanDownToClose
      backgroundStyle={{ 
        backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
      }}
      handleIndicatorStyle={{ 
        backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
      }}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      onChange={(index) => {
        if (index === -1 && onDismiss) {
          onDismiss();
        }
      }}
    >
      <BottomSheetView style={{ height: '100%' }}>
        <View className="h-full flex-col justify-between px-8 pt-8 pb-4">
          <View>
            <View 
              className="w-20 h-20 rounded-3xl items-center justify-center mb-6 bg-blue-500">
              <Icon as={Shield} size={34} className="text-white" strokeWidth={2} />
            </View>

            <Text className="text-3xl font-roobert-semibold text-foreground leading-tight mb-3">
              {t('auth.guest.title')}
            </Text>
            
            <Text className="text-base text-muted-foreground leading-relaxed">
              {t('auth.guest.description')}
            </Text>
          </View>
          <View className="w-full gap-4 pb-8">
            <AnimatedPressable
              onPress={handleAccept}
              onPressIn={() => {
                scale1.value = withSpring(0.96, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                scale1.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={[animatedStyle1, { 
                backgroundColor: isDark ? '#FFFFFF' : '#000000',
                height: 56,
                borderRadius: 28,
                justifyContent: 'center',
                alignItems: 'center',
              }]}
            >
              <Text style={{ 
                color: isDark ? '#000000' : '#FFFFFF',
                fontSize: 16,
                fontFamily: 'Roobert-Medium',
              }}>
                {t('auth.guest.continue')}
              </Text>
            </AnimatedPressable>

            <AnimatedPressable
              onPress={handleDecline}
              onPressIn={() => {
                scale2.value = withSpring(0.96, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                scale2.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={[animatedStyle2, { 
                backgroundColor: 'transparent',
                height: 56,
                borderRadius: 28,
                borderWidth: 1,
                borderColor: isDark ? '#454444' : '#c2c2c2',
                justifyContent: 'center',
                alignItems: 'center',
              }]}
            >
              <Text className="text-foreground text-[16px] font-roobert">
                {t('auth.guest.signUp')}
              </Text>
            </AnimatedPressable>

            <View className="flex-row flex-wrap">
              <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
                {t('auth.guest.agreement')}{' '}
              </Text>
              <TouchableOpacity onPress={handleOpenTerms}>
                <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
                  {t('auth.guest.terms')}
                </Text>
              </TouchableOpacity>
              <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
                {' '}{t('auth.guest.and')}{' '}
              </Text>
              <TouchableOpacity onPress={handleOpenPrivacy}>
                <Text className="text-[14px] font-roobert text-foreground leading-5 underline">
                  {t('auth.guest.privacy')}
                </Text>
              </TouchableOpacity>
              <Text className="text-[14px] font-roobert text-muted-foreground leading-5">
                .
              </Text>
            </View>
          </View>
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}
