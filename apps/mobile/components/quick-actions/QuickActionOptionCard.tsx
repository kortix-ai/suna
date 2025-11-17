import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import * as React from 'react';
import { Image, Pressable, View } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  withTiming,
  Easing
} from 'react-native-reanimated';
import type { QuickActionOption } from './quickActionViews';
import { useLanguage } from '@/contexts';
import { getQuickActionOptionTranslationKey } from './quickActionTranslations';
import { Check, Eye } from 'lucide-react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface QuickActionOptionCardProps {
  option: QuickActionOption;
  actionId: string;
  onPress: (optionId: string) => void;
  isSelected?: boolean;
  onPreview?: (optionId: string, optionLabel: string) => void;
}

/**
 * QuickActionOptionCard Component
 * 
 * Individual option card shown in expanded quick action view.
 * For slides mode: displays 16:9 aspect ratio with proper selected states
 * For other modes: displays square or icon-based preview
 */
export function QuickActionOptionCard({ option, actionId, onPress, isSelected = false, onPreview }: QuickActionOptionCardProps) {
  const { t } = useLanguage();
  const scale = useSharedValue(1);
  const checkmarkScale = useSharedValue(0);
  const borderOpacity = useSharedValue(0);
  
  // Initialize with correct state on mount without animation
  React.useLayoutEffect(() => {
    if (isSelected) {
      checkmarkScale.value = 1;
      borderOpacity.value = 1;
    }
  }, []);
  
  // Update checkmark animation when selection changes
  React.useEffect(() => {
    if (isSelected) {
      checkmarkScale.value = withSpring(1, { damping: 12, stiffness: 300 });
      borderOpacity.value = withTiming(1, { duration: 200 });
    } else {
      checkmarkScale.value = withTiming(0, { duration: 150 });
      borderOpacity.value = withTiming(0, { duration: 150 });
    }
  }, [isSelected, checkmarkScale, borderOpacity]);
  
  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
    };
  }, [scale]);

  const checkmarkStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: checkmarkScale.value }],
      opacity: checkmarkScale.value,
    };
  }, [checkmarkScale]);

  const borderStyle = useAnimatedStyle(() => {
    return {
      opacity: borderOpacity.value,
    };
  }, [borderOpacity]);

  // Get translated label
  const translationKey = getQuickActionOptionTranslationKey(actionId, option.id);
  const label = t(translationKey, { defaultValue: option.label });

  const handlePress = () => {
    console.log('🎯 Quick action option selected:', label);
    console.log('📊 Option data:', { id: option.id, label, isSelected });
    onPress(option.id);
  };

  // Determine if this is a slides/presentation template (16:9 aspect ratio)
  const isSlideTemplate = actionId === 'slides';
  const cardWidth = isSlideTemplate ? 160 : 100;
  const cardHeight = isSlideTemplate ? 90 : 100; // 16:9 for slides, square for others

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      style={animatedStyle}
    >
      <View className="items-center">
        {/* Image/Icon Preview */}
        <View className="relative">
          {option.imageUrl ? (
            <View 
              className="rounded-xl overflow-hidden mb-2 bg-muted/20" 
              style={{ width: cardWidth, height: cardHeight }}
            >
              {/* Image */}
              <Image 
                source={option.imageUrl}
                style={{ width: '100%', height: '100%' }}
                resizeMode={isSlideTemplate ? 'contain' : 'cover'}
              />
              
              {/* Border overlay for selected state */}
              {isSelected && (
                <Animated.View 
                  style={borderStyle}
                  className="absolute inset-0 border-[3px] border-primary rounded-xl pointer-events-none"
                />
              )}
              
              {/* Selected checkmark badge */}
              {isSelected && (
                <Animated.View 
                  style={checkmarkStyle}
                  className="absolute top-2 right-2 bg-primary rounded-full p-1 shadow-lg"
                >
                  <Icon 
                    as={Check} 
                    size={14} 
                    className="text-primary-foreground"
                    strokeWidth={3}
                  />
                </Animated.View>
              )}
              
              {/* Preview button for slides */}
              {isSlideTemplate && onPreview && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    onPreview(option.id, label);
                  }}
                  className="absolute top-2 left-2 bg-background/90 rounded-full p-1.5 shadow-lg active:bg-background"
                >
                  <Icon 
                    as={Eye} 
                    size={14} 
                    className="text-foreground"
                    strokeWidth={2.5}
                  />
                </Pressable>
              )}
              
              {/* Selection overlay */}
              {isSelected && (
                <Animated.View 
                  style={borderStyle}
                  className="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none"
                />
              )}
            </View>
          ) : option.icon ? (
            <View 
              className={`rounded-xl items-center justify-center mb-2 relative ${
                isSelected 
                  ? 'bg-primary/10 border-[3px] border-primary' 
                  : 'bg-card border border-border/30'
              }`} 
              style={{ width: cardWidth, height: cardHeight }}
            >
              <Icon 
                as={option.icon} 
                size={32} 
                className={isSelected ? 'text-primary' : 'text-foreground/70'}
                strokeWidth={2}
              />
              
              {/* Selected checkmark badge for icons */}
              {isSelected && (
                <Animated.View 
                  style={checkmarkStyle}
                  className="absolute top-2 right-2 bg-primary rounded-full p-1 shadow-lg"
                >
                  <Icon 
                    as={Check} 
                    size={12} 
                    className="text-primary-foreground"
                    strokeWidth={3}
                  />
                </Animated.View>
              )}
            </View>
          ) : null}
        </View>
        
        {/* Label */}
        <Text 
          className={`text-xs text-center font-roobert ${
            isSelected ? 'text-primary font-roobert-medium' : 'text-foreground/70'
          }`}
          style={{ width: cardWidth }}
          numberOfLines={2}
        >
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

