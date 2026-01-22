import * as React from 'react';
import { View, ScrollView, Platform, Pressable } from 'react-native';
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
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface UsagePageProps {
  visible: boolean;
  onClose: () => void;
}

export function UsagePage({ visible, onClose }: UsagePageProps) {
  const { t } = useLanguage();
  const chat = useChat();
  const [isPlanPageVisible, setIsPlanPageVisible] = React.useState(false);
  const { useNativePaywall, presentUpgradePaywall } = useUpgradePaywall();

  const handleClose = React.useCallback(() => {
    log.log('🎯 Usage page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleUpgradePress = React.useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();

    // If RevenueCat is available, present native paywall directly
    if (useNativePaywall) {
      log.log('📱 Using native RevenueCat paywall from UsagePage');
      setTimeout(async () => {
        await presentUpgradePaywall();
      }, 100);
    } else {
      // Otherwise, show the custom PlanPage
      setTimeout(() => setIsPlanPageVisible(true), 100);
    }
  }, [onClose, useNativePaywall, presentUpgradePaywall]);

  const handleThreadPress = React.useCallback(
    (threadId: string, _projectId: string | null) => {
      log.log('🎯 Thread pressed from UsagePage:', threadId);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Load the thread and close the page
      chat.loadThread(threadId);
      onClose();
    },
    [chat, onClose]
  );

  if (!visible) return null;

  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const backgroundColor = getBackgroundColor(Platform.OS, colorScheme);
  const topOffset = Math.max(insets.top, 16) + 8;

  return (
    <>
      <View style={{ flex: 1, backgroundColor, width: '100%', overflow: 'hidden' }}>
        <Pressable
          onPress={handleClose}
          style={{
            position: 'absolute',
            left: 16,
            top: topOffset,
            width: 44,
            height: 44,
            borderRadius: 22,
            zIndex: 100,
          }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          accessibilityHint="Closes the usage page"
        >
          {isLiquidGlassAvailable() && Platform.OS === 'ios' ? (
            <GlassView
              glassEffectStyle="regular"
              tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'}
              isInteractive
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 22,
                height: 44,
                width: 44,
                borderWidth: 0.5,
                borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
              }}
            >
              <Icon as={ChevronLeft} size={22} className="text-foreground" strokeWidth={2} />
            </GlassView>
          ) : (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)',
                borderRadius: 22,
                borderWidth: 0.5,
                borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
                ...(Platform.OS === 'android' ? {
                  elevation: 2,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.1,
                  shadowRadius: 4,
                } : {}),
              }}
            >
              <Icon as={ChevronLeft} size={22} className="text-foreground" strokeWidth={2} />
            </View>
          )}
        </Pressable>

        <ScrollView
          style={{ flex: 1, width: '100%', paddingTop: 120 }}
          contentContainerStyle={{ width: '100%' }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <UsageContent onThreadPress={handleThreadPress} onUpgradePress={handleUpgradePress} />
        </ScrollView>
      </View>
      <AnimatedPageWrapper
        visible={isPlanPageVisible}
        onClose={() => setIsPlanPageVisible(false)}
        disableGesture>
        <PlanPage visible onClose={() => setIsPlanPageVisible(false)} />
      </AnimatedPageWrapper>
    </>
  );
}
