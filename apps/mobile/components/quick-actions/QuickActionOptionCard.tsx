import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import * as React from 'react';
import { Image, Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import type { QuickActionOption } from './quickActionViews';
import { useLanguage } from '@/contexts';
import { getQuickActionOptionTranslationKey } from './quickActionTranslations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface QuickActionOptionCardProps {
  option: QuickActionOption;
  actionId: string;
  onPress: (optionId: string) => void;
  isSelected?: boolean;
}

/**
 * QuickActionOptionCard Component
 * 
 * Individual option card shown in expanded quick action view.
 * Displays image preview with label below.
 */
export function QuickActionOptionCard({ option, actionId, onPress, isSelected = false }: QuickActionOptionCardProps) {
  const { t } = useLanguage();
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Get translated label
  const translationKey = getQuickActionOptionTranslationKey(actionId, option.id);
  const label = t(translationKey, { defaultValue: option.label });

  const handlePress = () => {
    console.log('🎯 Quick action option selected:', label);
    console.log('📊 Option data:', { id: option.id, label, isSelected });
    onPress(option.id);
  };

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      className="mr-3"
      style={animatedStyle}
    >
      <View className="items-center">
        {/* Image Preview */}
        {option.imageUrl ? (
          <View 
            className={`rounded-2xl overflow-hidden mb-2 ${
              isSelected ? 'border-2 border-primary' : 'border border-border/50'
            }`} 
            style={{ width: 100, height: 100 }}
          >
            <Image 
              source={option.imageUrl}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          </View>
        ) : option.icon ? (
          <View 
            className={`rounded-2xl items-center justify-center mb-2 ${
              isSelected 
                ? 'bg-primary border-2 border-primary' 
                : 'bg-card border border-border/50'
            }`} 
            style={{ width: 100, height: 100 }}
          >
            <Icon 
              as={option.icon} 
              size={32} 
              className={isSelected ? 'text-primary-foreground' : 'text-foreground/70'}
              strokeWidth={2}
            />
          </View>
        ) : null}
        
        {/* Label */}
        <Text className={`text-xs text-center ${
          isSelected ? 'font-roobert-medium text-primary' : 'font-roobert text-foreground/80'
        }`}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

