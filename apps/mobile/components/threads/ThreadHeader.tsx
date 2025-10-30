import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu, MoreHorizontal } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThreadHeaderProps {
  threadTitle?: string;
  onTitleChange?: (newTitle: string) => void;
  onMenuPress?: () => void;
  onActionsPress?: () => void;
  isLoading?: boolean;
}

/**
 * ThreadHeader Component
 * 
 * Minimal, elegant floating header with glassmorphism effect
 * Designed with Vercel-level attention to detail
 * 
 * Features:
 * - Ultra-compact blur card design (py-2, px-3)
 * - Sleek 13px medium-weight typography
 * - Subtle icons with refined opacity (60%)
 * - Editable thread title (tap to edit)
 * - Smooth spring animations with haptic feedback
 * - Portal-based drawer compatibility (no z-index conflicts)
 */
export function ThreadHeader({
  threadTitle,
  onTitleChange,
  onMenuPress,
  onActionsPress,
  isLoading = false,
}: ThreadHeaderProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(threadTitle || '');
  const [isUpdating, setIsUpdating] = React.useState(false);
  const titleInputRef = React.useRef<TextInput>(null);

  const menuScale = useSharedValue(1);
  const actionScale = useSharedValue(1);

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
  }));

  const actionAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: actionScale.value }],
  }));

  React.useEffect(() => {
    if (threadTitle) {
      setEditedTitle(threadTitle);
    }
  }, [threadTitle]);

  const handleMenuPress = () => {
    console.log('🎯 Menu panel pressed (Thread View)');
    console.log('📱 Opening menu drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onMenuPress?.();
  };

  const handleTitlePress = () => {
    console.log('🎯 Thread title tapped');
    console.log('✏️ Entering edit mode');
    setIsEditingTitle(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Focus input after state update
    setTimeout(() => {
      titleInputRef.current?.focus();
    }, 100);
  };

  const handleTitleBlur = async () => {
    console.log('✅ Title editing complete');
    console.log('📝 New title:', editedTitle);
    setIsEditingTitle(false);
    
    if (editedTitle.trim() !== threadTitle && editedTitle.trim() !== '') {
      const newTitle = editedTitle.trim();
      setIsUpdating(true);
      try {
        await onTitleChange?.(newTitle);
        console.log('✅ Title updated successfully');
        // Optimistically keep the new title immediately after success
        setEditedTitle(newTitle);
      } catch (error) {
        console.error('❌ Failed to update title:', error);
        // Revert to original on error
        if (threadTitle) {
          setEditedTitle(threadTitle);
        }
      } finally {
        setIsUpdating(false);
      }
    } else {
      // Revert if empty or unchanged
      if (threadTitle) {
        setEditedTitle(threadTitle);
      }
    }
  };

  const handleActionsPress = () => {
    console.log('⚙️ Thread actions menu');
    console.log('📂 Thread:', threadTitle);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onActionsPress?.();
  };

  return (
    <View 
      className="absolute top-0 left-0 right-0"
      style={{ 
      }}
      pointerEvents="box-none" // Allow touches to pass through empty areas
    >
      {/* Floating card with solid background - Sleek minimal design */}
      <View className="relative rounded-2xl pt-12 border border-border/30 overflow-hidden">
        {/* Solid Background */}
        <View 
          className="absolute inset-0"
          style={{ 
            backgroundColor: colorScheme === 'dark' 
              ? '#161618' 
              : '#FFFFFF' 
          }}
        />

        {/* Main Content - Compact and minimal */}
        <View className="flex-row items-center justify-between px-3 py-2">
          {/* Left - Menu Button */}
          <AnimatedPressable
            onPressIn={() => {
              menuScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleMenuPress}
            style={menuAnimatedStyle}
            className="w-7 h-7 items-center justify-center -ml-1"
            accessibilityRole="button"
            accessibilityLabel="Open menu"
          >
            <Icon as={Menu} size={18} className="text-foreground/60" strokeWidth={2} />
          </AnimatedPressable>

          {/* Center - Thread Title (Editable) */}
          <View className="flex-1 mx-2.5 flex-row items-center justify-center">
            {isLoading || isUpdating ? (
              <KortixLoader size="small" />
            ) : isEditingTitle ? (
              <TextInput
                ref={titleInputRef}
                value={editedTitle}
                onChangeText={setEditedTitle}
                onBlur={handleTitleBlur}
                onSubmitEditing={handleTitleBlur}
                className="text-[13px] font-roobert-medium text-foreground text-center flex-1"
                style={{ fontFamily: 'Roobert-Medium' }}
                placeholder="Enter title"
                placeholderTextColor={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.3)' : 'rgba(0, 0, 0, 0.3)'}
                returnKeyType="done"
                selectTextOnFocus
                accessibilityLabel="Edit thread title"
              />
            ) : editedTitle ? (
              <Pressable 
                onPress={handleTitlePress} 
                hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                className="flex-1"
              >
                <Text 
                  className="text-[13px] font-roobert-medium text-foreground/80 text-center" 
                  numberOfLines={1}
                >
                  {editedTitle}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* Right - Actions Button (Minimal) */}
          <AnimatedPressable
            onPressIn={() => {
              actionScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              actionScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleActionsPress}
            style={actionAnimatedStyle}
            className="w-7 h-7 items-center justify-center rounded-full bg-secondary/40 -mr-1"
            accessibilityRole="button"
            accessibilityLabel="Thread actions"
          >
            <Icon as={MoreHorizontal} size={15} className="text-foreground/60" strokeWidth={2} />
          </AnimatedPressable>
        </View>
      </View>
    </View>
  );
}

