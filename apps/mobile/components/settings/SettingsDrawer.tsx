import * as React from 'react';
import { View, Platform, Dimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { useLanguage, useAuthContext } from '@/contexts';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SettingsIcon, X } from 'lucide-react-native';
import { log } from '@/lib/logger';
import { SettingsPage } from './SettingsPage';
import { NameEditPage } from './NameEditPage';
import { LanguagePage } from './LanguagePage';
import { ThemePage } from './ThemePage';
import { BetaPage } from './BetaPage';
import { AccountDeletionPage } from './AccountDeletionPage';
import type { UserProfile } from '../menu/types';
import { isLiquidGlassAvailable, GlassView } from 'expo-glass-effect';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface SettingsDrawerProps {
  visible: boolean;
  onClose: () => void;
  profile?: UserProfile;
}

type PageType = 'main' | 'name' | 'language' | 'theme' | 'beta' | 'account-deletion';

export function SettingsDrawer({ visible, onClose, profile }: SettingsDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheet>(null);
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const snapPoints = React.useMemo(() => ['95%'], []);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuthContext();
  
  const [currentPage, setCurrentPage] = React.useState<PageType>('main');
  const translateX = useSharedValue(0);

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef?.current && setTimeout(() => {
        log.log('📳 [SettingsDrawer] Fallback timeout - resetting guard');
        isOpeningRef.current = false;
      }, 500);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      log.log('📳 Haptic Feedback: Settings Drawer Opened');
      bottomSheetRef.current?.snapToIndex(0);
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.close();
    }
  }, [visible]);

  const handleClose = React.useCallback(() => {
    log.log('🎯 Settings drawer closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

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

  const handleSheetChange = React.useCallback((index: number) => {
    log.log('📳 [SettingsDrawer] Sheet index changed:', index);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (index === -1) {
      isOpeningRef.current = false;
      setCurrentPage('main');
      translateX.value = 0;
      onClose();
    } else if (index >= 0) {
      isOpeningRef.current = false;
    }
  }, [onClose]);

  const handleNavigate = React.useCallback((page: PageType) => {
    setCurrentPage(page);
    translateX.value = withTiming(SCREEN_WIDTH, {
      duration: 300,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
  }, []);

  const handleBack = React.useCallback(() => {
    translateX.value = withTiming(0, {
      duration: 300,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
    setTimeout(() => setCurrentPage('main'), 300);
  }, []);

  React.useEffect(() => {
    const targetValue = currentPage === 'main' ? 0 : SCREEN_WIDTH;
    if (Math.abs(translateX.value - targetValue) > 10) {
      translateX.value = withTiming(targetValue, {
        duration: 300,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    }
  }, [currentPage]);

  const mainPageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -translateX.value * 0.3 }],
    opacity: 1 - (translateX.value / SCREEN_WIDTH) * 0.3,
  }));

  const subPageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SCREEN_WIDTH - translateX.value }],
  }));


  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ display: 'none' }}
      backgroundStyle={{
        backgroundColor: Platform.OS === 'ios'
          ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
          : (colorScheme === 'dark' ? '#121212' : '#F5F5F5'),
        borderTopLeftRadius: Platform.OS === 'ios' ? 36 : 24,
        borderTopRightRadius: Platform.OS === 'ios' ? 36 : 24,
        overflow: 'hidden',
      }}
    >
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <View 
          pointerEvents={currentPage === 'main' ? 'auto' : 'none'}
          className="relative flex-row items-center justify-center px-6 py-3">
            <Text className="font-roobert-bold text-lg text-foreground">
              {t('settings.title', 'Settings')}
            </Text>
            <BottomSheetTouchable onPress={handleClose} activeOpacity={0.6} style={{ position: 'absolute', right: 24 }}>
              {isLiquidGlassAvailable() ? (
                <GlassView
                    glassEffectStyle="regular"
                    tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                    style={{
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRadius: 22,
                      height: 44,
                      width: 44,
                    }}>
                    <Icon as={X} size={22} className="text-foreground" strokeWidth={2} />
                  </GlassView>
                ) : (
                  <View
                    style={{
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED',
                      borderRadius: 22,
                      height: 44,
                      width: 44,
                    }}>
                    <Icon as={X} size={22} className="text-foreground" strokeWidth={2} />
                  </View>
              )}
          </BottomSheetTouchable>
        </View>
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 60,
              left: 0,
              right: 0,
              bottom: 0,
            },
            mainPageStyle,
          ]}
          pointerEvents={currentPage === 'main' ? 'auto' : 'none'}
        >
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom }}
            showsVerticalScrollIndicator={false}
          >
            <SettingsPage 
              visible={visible} 
              profile={profile} 
              onClose={handleClose} 
              isDrawer={true}
              onNavigate={handleNavigate}
            />
          </BottomSheetScrollView>
        </Animated.View>
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            },
            subPageStyle,
          ]}
          pointerEvents={currentPage !== 'main' ? 'auto' : 'none'}
        >
          {currentPage === 'name' && (
            <NameEditPage
              visible={true}
              currentName={user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
              onClose={handleBack}
            />
          )}
          {currentPage === 'language' && (
            <LanguagePage visible={true} onClose={handleBack} />
          )}
          {currentPage === 'theme' && (
            <ThemePage visible={true} onClose={handleBack} />
          )}
          {currentPage === 'beta' && (
            <BetaPage visible={true} onClose={handleBack} />
          )}
          {currentPage === 'account-deletion' && (
            <AccountDeletionPage visible={true} onClose={handleBack} />
          )}
        </Animated.View>
      </View>
    </BottomSheet>
  );
}
