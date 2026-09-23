import * as React from 'react';
import { View } from 'react-native';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { ChatCircleIcon as MessageCircle, BriefcaseIcon as Briefcase, LightningIcon as Zap } from '@/lib/icons';
import { log } from '@/lib/logger';

interface BottomNavProps {
  activeTab?: 'chats' | 'workers' | 'triggers';
  onChatsPress?: () => void;
  onWorkersPress?: () => void;
  onTriggersPress?: () => void;
}

/**
 * BottomNav Component
 * 
 * Elegant segmented control navigation with three tabs: Chats, Workers, and Triggers.
 * 
 * Design Specifications:
 * - Three-tab segmented control layout
 * - Active tab: Filled background with subtle border
 * - Inactive tab: Transparent background with subtle styling
 * - Icon + Label layout (vertical stack)
 * - Full-width equal distribution
 * - Smooth haptic feedback
 * - Spring animations for press interactions
 * 
 * Features:
 * - Chats (MessageCircle icon) for conversations
 * - Workers (Briefcase icon) for AI agents
 * - Triggers (Zap icon) for automation
 * - Haptic feedback on tab press
 * - Theme-aware colors
 * - Accessibility optimized
 */
export function BottomNav({ 
  activeTab = 'chats',
  onChatsPress,
  onWorkersPress,
  onTriggersPress,
}: BottomNavProps) {
  const { t } = useLanguage();
  
  return (
    <View className="flex-row items-center gap-2 w-full bg-transparent">
      <NavButton 
        icon={MessageCircle} 
        label={t('menu.chats')}
        isActive={activeTab === 'chats'}
        onPress={onChatsPress} 
      />
      <NavButton 
        icon={Briefcase} 
        label={t('menu.workers')}
        isActive={activeTab === 'workers'}
        onPress={onWorkersPress} 
      />
      <NavButton 
        icon={Zap} 
        label={t('menu.triggers')}
        isActive={activeTab === 'triggers'}
        onPress={onTriggersPress} 
      />
    </View>
  );
}

interface NavButtonProps {
  icon: typeof MessageCircle;
  label: string;
  isActive?: boolean;
  onPress?: () => void;
}

/**
 * NavButton Component
 * 
 * Individual navigation tab with icon and label in segmented control style.
 * 
 * Design Specifications:
 * - Height: 96px (h-24) for comfortable touch target
 * - Icon: 24px with icon above label
 * - Text: 15px font-roobert-medium
 * - Active: Filled background (bg-card) with border
 * - Inactive: Subtle background with transparency
 * - Border radius: 16px (rounded-2xl)
 * - Press animation: Scale to 0.98
 * - Gap: 8px (gap-2) between icon and label
 * 
 * Interactions:
 * - Haptic feedback on press (Light impact)
 * - Smooth spring animation
 * - Prevents double activation
 */
function NavButton({ icon, label, isActive = false, onPress }: NavButtonProps) {
  const handlePress = () => {
    log.log('🎯 Bottom nav tab pressed:', label);
    log.log('📊 Active state:', isActive);
    log.log('⏰ Timestamp:', new Date().toISOString());

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Don't trigger if already active
    if (isActive) {
      log.log('ℹ️ Tab already active, skipping callback');
      return;
    }

    onPress?.();
  };

  return (
    <Button
      variant="ghost"
      onPress={handlePress}
      className={`h-24 flex-1 flex-col gap-2 rounded-2xl ${
        isActive ? 'border-[1.5px] border-border bg-card' : 'bg-card/30'
      }`}
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityHint={`Switch to ${label} view`}
    >
      <Icon as={icon} size={24} className={isActive ? 'text-foreground' : 'text-foreground/60'} />
      <Text className={isActive ? 'text-foreground' : 'text-foreground/60'}>{label}</Text>
    </Button>
  );
}

