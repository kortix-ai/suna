/**
 * Plan Selection Modal Component
 * 
 * Full-screen modal matching frontend's PlanSelectionModal design exactly
 * Uses hooks directly like frontend (no context)
 */

import React from 'react';
import { View, Pressable, ScrollView, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import { PricingSection } from './PricingSection';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/lib/billing';
import * as Haptics from 'expo-haptics';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  FadeIn,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedView = Animated.createAnimatedComponent(View);

interface PlanSelectionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnUrl?: string;
  creditsExhausted?: boolean;
}

export function PlanSelectionModal({
  open,
  onOpenChange,
  returnUrl,
  creditsExhausted = false,
}: PlanSelectionModalProps) {
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 16) + 20;

  const closeButtonScale = useSharedValue(1);

  const closeButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeButtonScale.value }],
  }));

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenChange(false);
  };

  const handleSubscriptionUpdate = () => {
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    setTimeout(() => {
      onOpenChange(false);
    }, 500);
  };

  if (!open) return null;

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <View className="flex-1 bg-background">
        <AnimatedView 
          entering={FadeIn.duration(400)}
          className="absolute top-0 left-0 right-0 z-50 flex-row items-center justify-end px-6 bg-background/95"
          style={{ paddingTop: topPadding, paddingBottom: 16 }}
        >
          <AnimatedPressable
            onPress={handleClose}
            onPressIn={() => {
              closeButtonScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              closeButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            style={closeButtonStyle}
            className="h-8 w-8 rounded-full bg-muted/30 items-center justify-center"
          >
            <Icon as={X} size={14} className="text-muted-foreground" strokeWidth={2.5} />
          </AnimatedPressable>
        </AnimatedView>

        <ScrollView 
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: topPadding + 60, paddingBottom: 40 }}
        >
          <PricingSection
            returnUrl={returnUrl}
            showTitleAndTabs={true}
            insideDialog={true}
            noPadding={false}
            customTitle={creditsExhausted ? "You ran out of credits. Upgrade now." : undefined}
            onSubscriptionUpdate={handleSubscriptionUpdate}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
