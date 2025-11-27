import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageCircle, Briefcase, Zap } from 'lucide-react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  const handlePress = () => {
    console.log('🎯 Bottom nav tab pressed:', label);
    console.log('📊 Active state:', isActive);
    console.log('⏰ Timestamp:', new Date().toISOString());
    
    // Haptic feedback
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    // Don't trigger if already active
    if (isActive) {
      console.log('ℹ️ Tab already active, skipping callback');
      return;
    }
    
    onPress?.();
  };
  
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className={`flex-1 items-center justify-center rounded-2xl h-24 ${
        isActive 
          ? 'bg-card border-[1.5px] border-border' 
          : 'bg-card/30'
      }`}
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityHint={`Switch to ${label} view`}
    >
      <View className="items-center justify-center gap-2">
        <Icon 
          as={icon}
          size={24}
          className={isActive ? 'text-foreground' : 'text-foreground/60'}
          strokeWidth={2}
        />
        <Text 
          className={`text-[15px] font-roobert-medium ${
            isActive ? 'text-foreground' : 'text-foreground/60'
          }`}
        >
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

