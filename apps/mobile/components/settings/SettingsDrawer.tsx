import * as React from 'react';
import { View, Platform, ScrollView, TouchableOpacity } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { useLanguage, useAuthContext } from '@/contexts';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { ReanimatedTrueSheet } from '@lodev09/react-native-true-sheet/reanimated';
import type { TrueSheet } from '@lodev09/react-native-true-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, ChevronLeft } from 'lucide-react-native';
import { log } from '@/lib/logger';
import { SettingsPage } from './SettingsPage';
import { NameEditPage } from './NameEditPage';
import { LanguagePage } from './LanguagePage';
import { ThemePage } from './ThemePage';
import { BetaPage } from './BetaPage';
import { AccountDeletionPage } from './AccountDeletionPage';
import type { UserProfile } from '../menu/types';
import { isLiquidGlassAvailable, GlassView } from 'expo-glass-effect';
import { getBorderRadius, getDrawerBackgroundColor } from '@agentpress/shared';

interface SettingsDrawerProps {
  visible: boolean;
  onClose: () => void;
  profile?: UserProfile;
}

type PageType = 'main' | 'name' | 'language' | 'theme' | 'beta' | 'account-deletion';

export function SettingsDrawer({ visible, onClose, profile }: SettingsDrawerProps) {
  const trueSheetRef = React.useRef<TrueSheet>(null);
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const snapPoints = React.useMemo(() => ['95%'], []);
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { user } = useAuthContext();

  const [currentPage, setCurrentPage] = React.useState<PageType>('main');

  const cornerRadius = getBorderRadius(Platform.OS, '2xl');

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef?.current && setTimeout(() => {
        isOpeningRef.current = false;
      }, 500);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      if (Platform.OS === 'ios') {
        trueSheetRef.current?.present();
      } else {
        bottomSheetRef.current?.present();
      }
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      setCurrentPage('main');

      if (Platform.OS === 'ios') {
        trueSheetRef.current?.dismiss();
      } else {
        bottomSheetRef.current?.dismiss();
      }
    }
  }, [visible]);

  const handleClose = React.useCallback(() => {
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

  const handleSheetChange = React.useCallback(
    (index: number) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (index === -1) {
        isOpeningRef.current = false;
        setCurrentPage('main');
        onClose();
      } else if (index >= 0) {
        isOpeningRef.current = false;
      }
    },
    [onClose]
  );

  const handleDismiss = React.useCallback(() => {
    isOpeningRef.current = false;
    setCurrentPage('main');
    onClose();
  }, [onClose]);

  const handleNavigate = React.useCallback((page: PageType) => {
    setCurrentPage(page);
  }, []);

  const handleBack = React.useCallback(() => {
    setCurrentPage('main');
  }, []);

  const getPageTitle = () => {
    switch (currentPage) {
      case 'name':
        return t('nameEdit.title');
      case 'language':
        return t('language.title');
      case 'theme':
        return t('theme.title');
      case 'beta':
        return t('beta.title');
      case 'account-deletion':
        return t('accountDeletion.title');
      default:
        return t('settings.title', 'Settings');
    }
  };

  const renderHeader = () => (
    <View className="relative flex-row items-center justify-center px-6 py-3">
      {currentPage !== 'main' && (
        <TouchableOpacity
          onPress={handleBack}
          activeOpacity={0.6}
          style={{ position: 'absolute', left: 24 }}
        >
          {isLiquidGlassAvailable() && Platform.OS === 'ios' ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
              style={{
                justifyContent: 'center',
                alignItems: 'center',
                borderRadius: 22,
                height: 44,
                width: 44,
              }}
            >
              <Icon as={ChevronLeft} size={22} className="text-foreground" strokeWidth={2} />
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
              }}
            >
              <Icon as={ChevronLeft} size={22} className="text-foreground" strokeWidth={2} />
            </View>
          )}
        </TouchableOpacity>
      )}
      <Text className="font-roobert-bold text-lg text-foreground">{getPageTitle()}</Text>
      <TouchableOpacity
        onPress={handleClose}
        activeOpacity={0.6}
        style={{ position: 'absolute', right: 24 }}
      >
        {isLiquidGlassAvailable() && Platform.OS === 'ios' ? (
          <GlassView
            glassEffectStyle="regular"
            tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: 22,
              height: 44,
              width: 44,
            }}
          >
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
            }}
          >
            <Icon as={X} size={22} className="text-foreground" strokeWidth={2} />
          </View>
        )}
      </TouchableOpacity>
    </View>
  );

  const renderContent = () => {
    const ScrollComponent = Platform.OS === 'ios' ? ScrollView : BottomSheetScrollView;

    return (
      <ScrollComponent
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ paddingBottom: insets.bottom, width: '100%' }}
        showsVerticalScrollIndicator={false}
      >
        {currentPage === 'main' && (
          <SettingsPage
            visible={visible}
            profile={profile}
            onClose={handleClose}
            isDrawer={true}
            onNavigate={handleNavigate}
          />
        )}
        {currentPage === 'name' && (
          <NameEditPage
            visible={true}
            currentName={user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
            onClose={handleBack}
            isDrawer={true}
          />
        )}
        {currentPage === 'language' && (
          <LanguagePage visible={true} onClose={handleBack} isDrawer={true} />
        )}
        {currentPage === 'theme' && <ThemePage visible={true} onClose={handleBack} isDrawer={true} />}
        {currentPage === 'beta' && <BetaPage visible={true} onClose={handleBack} isDrawer={true} />}
        {currentPage === 'account-deletion' && (
          <AccountDeletionPage visible={true} onClose={handleBack} isDrawer={true} />
        )}
      </ScrollComponent>
    );
  };

  const sheetContent = (
    <View
      style={{
        flex: 1,
        overflow: 'hidden',
        width: '100%',
        backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
      }}
    >
      {renderHeader()}
      {renderContent()}
    </View>
  );

  return (
    <>
      {Platform.OS === 'ios' && (
        <ReanimatedTrueSheet
          ref={trueSheetRef}
          detents={[0.95]}
          onDidDismiss={handleDismiss}
          cornerRadius={cornerRadius}
          initialDetentIndex={0}
        >
          {sheetContent}
        </ReanimatedTrueSheet>
      )}

      {Platform.OS === 'android' && (
        <BottomSheetModal
          ref={bottomSheetRef}
          index={0}
          snapPoints={snapPoints}
          onChange={handleSheetChange}
          backdropComponent={renderBackdrop}
          handleIndicatorStyle={{ display: 'none' }}
          backgroundStyle={{
            backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
            borderTopLeftRadius: getBorderRadius(Platform.OS, '2xl'),
            borderTopRightRadius: getBorderRadius(Platform.OS, '2xl'),
            overflow: 'hidden',
            width: '100%',
          }}
          style={{
            width: '100%',
          }}
        >
          <BottomSheetView style={{ flex: 1, width: '100%' }}>{sheetContent}</BottomSheetView>
        </BottomSheetModal>
      )}
    </>
  );
}
