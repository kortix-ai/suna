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
  const topPadding = Math.max(insets.top, 16) + 20; // Match frontend pt-[67px] ≈ 67px total

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onOpenChange(false);
  };

  const handleSubscriptionUpdate = () => {
    // Invalidate all billing queries
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
    // Close modal after successful upgrade
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
        {/* Header with Logo and Close Button - matches frontend exactly */}
        <View 
          className="absolute top-0 left-0 right-0 z-50 flex-row items-center justify-between px-6 border-b border-border/50 bg-background/95"
          style={{ paddingTop: topPadding, paddingBottom: 20 }}
        >
          {/* Spacer for centering */}
          <View className="flex-1" />
          
          {/* Kortix Logo - Dead Center */}
          <View 
            style={{ 
              position: 'absolute', 
              left: SCREEN_WIDTH / 2 - 10, // Center minus half logo width
              top: topPadding + 10 // Center vertically in header
            }}
          >
            <Logomark width={20} height={20} />
          </View>
          
          {/* Close button - Right aligned */}
          <View className="flex-1 flex-row justify-end">
            <Pressable
              onPress={handleClose}
              className="h-9 w-9 rounded-full bg-background/80 border border-border/50 items-center justify-center"
            >
              <Icon as={X} size={16} className="text-foreground" strokeWidth={2} />
            </Pressable>
          </View>
        </View>

        {/* Full-screen pricing content */}
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

