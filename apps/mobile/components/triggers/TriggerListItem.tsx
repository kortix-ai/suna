/**
 * Trigger List Item Component
 * 
 * Displays individual trigger in a list with agent info, status, and actions
 * Matches the app's design system (ConversationItem pattern)
 */

import React from 'react';
import { Pressable, View, type ViewProps } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { getTriggerIcon, getTriggerCategory, formatCronExpression, getTriggerStatusText, getTriggerStatusColor, getTriggerStatusBgColor, formatTriggerDate } from '@/lib/trigger-utils';
import type { TriggerWithAgent } from '@/api/types';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface TriggerListItemProps extends ViewProps {
  trigger: TriggerWithAgent;
  onPress?: (trigger: TriggerWithAgent) => void;
  showAgent?: boolean;
  compact?: boolean;
}

export function TriggerListItem({
  trigger,
  onPress,
  showAgent = true,
  compact = false,
  style,
  ...props
}: TriggerListItemProps) {
  const { colorScheme } = useColorScheme();
  const IconComponent = getTriggerIcon(trigger.trigger_type);
  const category = getTriggerCategory(trigger.trigger_type);
  const statusText = getTriggerStatusText(trigger.is_active);
  const statusColor = getTriggerStatusColor(trigger.is_active);
  const statusBgColor = getTriggerStatusBgColor(trigger.is_active);
  const formattedDate = formatTriggerDate(trigger.created_at);
  const scale = useSharedValue(1);

  // Animated style for press feedback - matches ConversationItem
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.(trigger);
  };

  const getScheduleInfo = () => {
    if (category === 'scheduled' && trigger.config?.cron_expression) {
      return formatCronExpression(trigger.config.cron_expression);
    }
    return null;
  };

  const scheduleInfo = getScheduleInfo();

  // Icon container styles - matches ConversationItem design system
  const iconContainerStyles = colorScheme === 'dark'
    ? 'bg-[#161618] border-[#232324]'
    : 'bg-white border-[#DCDCDC]';
  
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const textColor = colorScheme === 'dark' ? 'text-white' : 'text-black';

  if (compact) {
    return (
      <AnimatedPressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[animatedStyle, style]}
        className="flex-row items-center gap-2.5 w-full"
        accessibilityRole="button"
        accessibilityLabel={`Open trigger: ${trigger.name}`}
        {...props}
      >
        {/* Icon Container - 48x48px compact design (matches ConversationItem) */}
        <View 
          className={`${iconContainerStyles} rounded-2xl items-center justify-center border-[1.5px]`}
          style={{ width: 48, height: 48 }}
        >
          <Icon as={IconComponent} size={20} color={iconColor} />
        </View>
        
        {/* Content Section - Compact spacing */}
        <View className="flex-1 gap-2 justify-center" style={{ minHeight: 48 }}>
          {/* Title & Status Row */}
          <View className="flex-row items-center justify-between gap-3">
            <Text className={`text-base font-roobert-medium ${textColor} flex-1`} numberOfLines={1}>
              {trigger.name}
            </Text>
            <View className={`px-2 py-1 rounded-full ${statusBgColor}`}>
              <Text className={`text-xs font-roobert-medium ${statusColor}`}>
                {statusText}
              </Text>
            </View>
          </View>
          
          {/* Description */}
          {trigger.description && (
            <Text 
              className={`text-sm font-roobert ${textColor} opacity-40`}
              numberOfLines={1}
            >
              {trigger.description}
            </Text>
          )}
        </View>
      </AnimatedPressable>
    );
  }

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[animatedStyle, style]}
      className="flex-row items-center gap-2.5 w-full"
      accessibilityRole="button"
      accessibilityLabel={`Open trigger: ${trigger.name}`}
      {...props}
    >
      {/* Icon Container - 48x48px design (matches ConversationItem) */}
      <View 
        className={`${iconContainerStyles} rounded-2xl items-center justify-center border-[1.5px]`}
        style={{ width: 48, height: 48 }}
      >
        <Icon as={IconComponent} size={20} color={iconColor} />
      </View>
      
      {/* Content Section */}
      <View className="flex-1 gap-2 justify-center" style={{ minHeight: 48 }}>
        {/* Title & Status Row */}
        <View className="flex-row items-center justify-between gap-3">
          <Text className={`text-base font-roobert-medium ${textColor} flex-1`} numberOfLines={1}>
            {trigger.name}
          </Text>
          <View className={`px-2 py-1 rounded-full ${statusBgColor}`}>
            <Text className={`text-xs font-roobert-medium ${statusColor}`}>
              {statusText}
            </Text>
          </View>
        </View>
        
        {/* Description */}
        {trigger.description && (
          <Text 
            className={`text-sm font-roobert ${textColor} opacity-40`}
            numberOfLines={1}
          >
            {trigger.description}
          </Text>
        )}
        
        {/* Agent Info */}
        {showAgent && (
          <View className="flex-row items-center">
            <AgentAvatar
              agent={{
                agent_id: trigger.agent_id,
                name: trigger.agent_name,
                icon_name: trigger.icon_name,
                icon_color: trigger.icon_color,
                icon_background: trigger.icon_background,
                configured_mcps: [],
                agentpress_tools: {},
                is_default: false,
                created_at: trigger.created_at,
                updated_at: trigger.updated_at,
              }}
              size={16}
            />
            <Text className={`text-xs font-roobert-medium ${textColor} opacity-50 ml-2`}>
              {trigger.agent_name}
            </Text>
            {scheduleInfo && (
              <Text className={`text-xs font-roobert ${textColor} opacity-50 ml-2`}>
                • {scheduleInfo}
              </Text>
            )}
          </View>
        )}
      </View>
    </AnimatedPressable>
  );
}
