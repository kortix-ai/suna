import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, MoreHorizontal } from 'lucide-react-native';
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
}

/**
 * ThreadHeader Component
 * 
 * Clean, minimal navigation header for chat thread view
 * Matches ChatInput design language with elegant simplicity
 * 
 * Features:
 * - ChevronRight icon (left) - opens menu drawer
 * - Editable thread title (center, tap to edit)
 * - Action icons in clean containers (right)
 * - Smooth spring animations with haptic feedback
 * - Minimal, elegant design
 */
export function ThreadHeader({
  threadTitle,
  onTitleChange,
  onMenuPress,
  onActionsPress,
}: ThreadHeaderProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const defaultTitle = t('chat.newChat');
  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(threadTitle || defaultTitle);
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
    setEditedTitle(threadTitle || defaultTitle);
  }, [threadTitle, defaultTitle]);

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

  const handleTitleBlur = () => {
    console.log('✅ Title editing complete');
    console.log('📝 New title:', editedTitle);
    setIsEditingTitle(false);
    if (editedTitle.trim() !== threadTitle && editedTitle.trim() !== '') {
      onTitleChange?.(editedTitle.trim());
    } else {
      // Revert if empty
      setEditedTitle(threadTitle || '');
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
      className="absolute top-0 left-0 right-0 bg-background z-50 border-b border-border/20" 
      style={{ paddingTop: insets.top }}
    >
      <View className="flex-row items-center justify-between px-6 py-3">
      {/* Left - Chevron Menu Button */}
      <AnimatedPressable
        onPressIn={() => {
          menuScale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={handleMenuPress}
        style={menuAnimatedStyle}
        className="w-8 h-8 items-center justify-center -ml-2"
        accessibilityRole="button"
        accessibilityLabel="Open menu"
      >
        <Icon as={ChevronRight} size={20} className="text-foreground/70" strokeWidth={2} />
      </AnimatedPressable>

      {/* Center - Thread Title (Editable) */}
      <View className="flex-1 mx-4">
        {isEditingTitle ? (
          <TextInput
            ref={titleInputRef}
            value={editedTitle}
            onChangeText={setEditedTitle}
            onBlur={handleTitleBlur}
            onSubmitEditing={handleTitleBlur}
            className="text-sm font-roobert-semibold text-foreground text-center"
            style={{ fontFamily: 'Roobert-Semibold' }}
            placeholder={t('chat.threadTitle')}
            placeholderTextColor={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.3)' : 'rgba(0, 0, 0, 0.3)'}
            returnKeyType="done"
            selectTextOnFocus
            accessibilityLabel={t('chat.editTitle')}
          />
        ) : (
          <Pressable onPress={handleTitlePress} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
            <Text 
              className="text-sm font-roobert-semibold text-foreground text-center" 
              numberOfLines={1}
            >
              {threadTitle}
            </Text>
          </Pressable>
        )}
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
        className="w-8 h-8 items-center justify-center rounded-full bg-secondary/50 -mr-2"
        accessibilityRole="button"
        accessibilityLabel="Thread actions"
      >
        <Icon as={MoreHorizontal} size={16} className="text-foreground/70" strokeWidth={2} />
      </AnimatedPressable>
      </View>
    </View>
  );
}

