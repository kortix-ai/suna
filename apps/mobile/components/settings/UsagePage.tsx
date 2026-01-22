import * as React from 'react';
import { View, ScrollView, Platform, Pressable, StatusBar } from 'react-native';
import * as Haptics from 'expo-haptics';
import { UsageContent } from './UsageContent';
import { PlanPage } from './PlanPage';
import { useLanguage } from '@/contexts';
import { useChat } from '@/hooks';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { useUpgradePaywall } from '@/hooks/useUpgradePaywall';
import { log } from '@/lib/logger';
import { getBackgroundColor } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';
import { Icon } from '@/components/ui/icon';
import { ChevronLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LiquidGlass } from '@/components/ui/liquid-glass';

interface UsagePageProps {
  visible: boolean;
  onClose: () => void;
}

export function UsagePage({ visible, onClose }: UsagePageProps) {
  const { t } = useLanguage();
  const chat = useChat();
  const [isPlanPageVisible, setIsPlanPageVisible] = React.useState(false);
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const isIOS = Platform.OS === 'ios';

  const handleClose = React.useCallback(() => {
    log.log('🎯 Usage page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleUpgradePress = React.useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();

    if (useNativePaywall) {
      log.log('📱 Using native RevenueCat paywall from UsagePage');
      setTimeout(async () => {
        await presentUpgradePaywall();
      }, 100);
    } else {
      setTimeout(() => setIsPlanPageVisible(true), 100);
    }
  }, [onClose, useNativePaywall, presentUpgradePaywall]);

  const handleThreadPress = React.useCallback(
    (threadId: string, _projectId: string | null) => {
      log.log('🎯 Thread pressed from UsagePage:', threadId);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      chat.loadThread(threadId);
      onClose();
    },
    [chat, onClose]
  );

  if (!visible) return null;

  const backgroundColor = getBackgroundColor(Platform.OS, colorScheme);
  const topOffset = Math.max(insets.top, 16) + 8;

  return (
    <>
      <StatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={{ flex: 1, backgroundColor, width: '100%', overflow: 'hidden' }}>
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            paddingTop: topOffset,
            paddingHorizontal: 16,
            paddingBottom: 12,
            zIndex: 100,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Pressable
            onPress={handleClose}
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
            }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            accessibilityHint="Closes the usage page"
          >
            <LiquidGlass
              variant="card"
              borderRadius={20}
              isInteractive
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon as={ChevronLeft} size={22} className="text-foreground" strokeWidth={2} />
            </LiquidGlass>
          </Pressable>
        </View>
        <ScrollView
          style={{ flex: 1, width: '100%' }}
          contentContainerStyle={{
            width: '100%',
            paddingTop: topOffset + 56,
            paddingBottom: insets.bottom + 24,
          }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <UsageContent onThreadPress={handleThreadPress} onUpgradePress={handleUpgradePress} />
        </ScrollView>
      </View>
      <AnimatedPageWrapper
        visible={isPlanPageVisible}
        onClose={() => setIsPlanPageVisible(false)}
        disableGesture
      >
        <PlanPage visible onClose={() => setIsPlanPageVisible(false)} />
      </AnimatedPageWrapper>
    </>
  );
}
