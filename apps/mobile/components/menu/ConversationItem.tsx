import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { formatConversationDate } from '@/lib/date';
import { Text } from '@/components/ui/text';
import { ThreadIcon } from '@/components/shared/ThreadIcon';
import type { Conversation } from './types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ConversationItemProps {
  conversation: Conversation;
  onPress?: (conversation: Conversation) => void;
}

/**
 * ConversationItem Component
 * 
 * Individual conversation list item with icon, title, date, and optional preview.
 * 
 * Design Specifications (Figma: 375-10439, 375-10440):
 * - Compact design: 48px height
 * - Icon container: 48x48px (reduced from 52px for compact layout)
 * - Icon size: 20px (compact)
 * - Gap between icon and content: 10px (gap-2.5)
 * - Light Mode: White background (#FFFFFF), gainsboro border (#DCDCDC), black icon
 * - Dark Mode: Dark background (#161618), #232324 border, white icon
 * - Border: 1.5px solid
 * - Border radius: 16px (rounded-2xl)
 * - Typography: Roobert-Medium 16px (title), Roobert-Medium 12px (date)
 * - Press animation: Scale to 0.97
 */
export function ConversationItem({ conversation, onPress }: ConversationItemProps) {
  const { colorScheme } = useColorScheme();
  const { currentLanguage } = useLanguage();
  const scale = useSharedValue(1);
  
  // Format date based on current locale
  const formattedDate = React.useMemo(
    () => formatConversationDate(conversation.timestamp, currentLanguage),
    [conversation.timestamp, currentLanguage]
  );
  
  /**
   * Animated style for press feedback
   * Scales down to 0.97 on press for tactile feedback
   */
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  /**
   * Handle conversation selection
   * Logs selection for debugging and calls parent callback
   */
  const handlePress = () => {
    console.log('🎯 Conversation selected:', conversation.title);
    console.log('📊 Conversation data:', conversation);
    onPress?.(conversation);
  };
  
  /**
   * Icon container styles - Exact colors from Figma
   * Light: #FFFFFF bg, #DCDCDC border, #000000 icon
   * Dark: #161618 bg, #232324 border, #FFFFFF icon
   */
  const iconContainerStyles = colorScheme === 'dark'
    ? 'bg-[#161618] border-[#232324]'  // Figma: 375-10440 (compact version)
    : 'bg-white border-[#DCDCDC]';      // Figma: 177-5364, 177-5335
  
  const iconColor = colorScheme === 'dark' ? 'text-white' : 'text-black';
  const textColor = colorScheme === 'dark' ? 'text-white' : 'text-black';
  
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="flex-row items-center gap-2.5 w-full"
      accessibilityRole="button"
      accessibilityLabel={`Open conversation: ${conversation.title}`}
    >
      {/* Icon Container - 48x48px compact design (Figma: 375-10440) */}
      <View 
        className={`${iconContainerStyles} rounded-2xl items-center justify-center border-[1.5px]`}
        style={{ width: 48, height: 48 }}
      >
        <ThreadIcon 
          iconName={conversation.iconName}
          size={20}
          className={iconColor}
        />
      </View>
      
      {/* Content Section - Compact spacing */}
      <View className="flex-1 gap-2 justify-center" style={{ minHeight: 48 }}>
        {/* Title & Date Row */}
        <View className="flex-row items-center justify-between gap-3">
          <Text className={`text-base font-roobert-medium ${textColor} flex-1`} numberOfLines={1}>
            {conversation.title}
          </Text>
          <Text className={`text-xs font-roobert-medium ${textColor} opacity-50`}>
            {formattedDate}
          </Text>
        </View>
        
        {/* Optional Preview Text */}
        {conversation.preview && (
          <Text 
            className={`text-sm font-roobert ${textColor} opacity-40`}
            numberOfLines={1}
          >
            {conversation.preview}
          </Text>
        )}
      </View>
    </AnimatedPressable>
  );
}

