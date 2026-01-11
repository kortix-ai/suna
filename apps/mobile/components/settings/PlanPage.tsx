/**
 * Plan Page Component - Fallback
 *
 * Simple fallback when RevenueCat native paywall is not available.
 * Directs users to the web to subscribe.
 */

import React from 'react';
import { View, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, ExternalLink } from 'lucide-react-native';
import { useLanguage } from '@/contexts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn } from 'react-native-reanimated';

const AnimatedView = Animated.createAnimatedComponent(View);

interface PlanPageProps {
  visible?: boolean;
  onClose?: () => void;
  onPurchaseComplete?: () => void;
}

export function PlanPage({ visible = true, onClose }: PlanPageProps) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();

  const handleOpenWeb = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Linking.openURL('https://www.kortix.com');
  };

  if (!visible) return null;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <AnimatedView
        entering={FadeIn.duration(400)}
        className="border-b border-border/30 bg-background px-6"
        style={{ paddingTop: insets.top + 12, paddingBottom: 16 }}>
        <View className="flex-row items-center justify-end">
          {onClose && (
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }}
              className="-mr-2 h-10 w-10 items-center justify-center">
              <Icon as={X} size={20} className="text-muted-foreground" strokeWidth={2} />
            </Pressable>
          )}
        </View>
      </AnimatedView>

      {/* Content */}
      <View className="flex-1 items-center justify-center px-8">
        <AnimatedView entering={FadeIn.duration(600).delay(200)} className="items-center">
          <Text className="mb-4 text-center font-roobert-semibold text-xl text-foreground">
            {t('billing.checkoutUnavailable', 'Mobile checkout not available')}
          </Text>
          <Text className="mb-8 text-center text-base leading-relaxed text-muted-foreground">
            {t(
              'billing.checkoutUnavailableMessage',
              'To subscribe to a plan, please visit kortix.com on the web.'
            )}
          </Text>

          <Pressable
            onPress={handleOpenWeb}
            className="flex-row items-center gap-2 rounded-xl bg-primary px-6 py-3">
            <Text className="font-roobert-medium text-base text-primary-foreground">
              {t('billing.goToWeb', 'Go to kortix.com')}
            </Text>
            <Icon as={ExternalLink} size={18} className="text-primary-foreground" strokeWidth={2} />
          </Pressable>
        </AnimatedView>
      </View>
    </View>
  );
}
