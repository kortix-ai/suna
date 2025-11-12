/**
 * Plan Selection Modal Component
 * 
 * Full-screen modal matching frontend's PlanSelectionModal design exactly
 * Uses hooks directly like frontend (no context)
 */

import React from 'react';
import { View, Pressable, ScrollView, Modal, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import LogomarkBlack from '@/assets/brand/Logomark-Black.svg';
import LogomarkWhite from '@/assets/brand/Logomark-White.svg';
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

const SCREEN_WIDTH = Dimensions.get('window').width;

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
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const Logomark = colorScheme === 'dark' ? LogomarkWhite : LogomarkBlack;
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
          className="absolute top-0 left-0 right-0 z-50 flex-row items-center justify-between px-6 border-b border-border/50 bg-background/95"
          style={{ paddingTop: topPadding, paddingBottom: 20 }}
        >
          <View className="flex-1" />
          
          <AnimatedView 
            entering={FadeIn.duration(600).delay(100)}
            style={{ 
              position: 'absolute', 
              left: SCREEN_WIDTH / 2 - 10,
              top: topPadding + 10
            }}
          >
            <Logomark width={20} height={20} />
          </AnimatedView>
          
          <View className="flex-1 flex-row justify-end">
            <AnimatedPressable
              onPress={handleClose}
              onPressIn={() => {
                closeButtonScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                closeButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={closeButtonStyle}
              className="h-9 w-9 rounded-full bg-card border border-border items-center justify-center"
            >
              <Icon as={X} size={16} className="text-foreground" strokeWidth={2.5} />
            </AnimatedPressable>
          </View>
        </AnimatedView>

        <ScrollView 
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: topPadding + 20 + 20, paddingBottom: 40 }}
        >
          <PricingSection
            returnUrl={returnUrl}
            showTitleAndTabs={true}
            insideDialog={false}
            noPadding={true}
            customTitle={creditsExhausted ? "You ran out of credits. Upgrade now." : undefined}
            onSubscriptionUpdate={handleSubscriptionUpdate}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

