import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import {
  ChevronLeft,
  MoreHorizontal,
  Check,
} from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ThreadActionsDrawer } from './ThreadActionsDrawer';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThreadHeaderProps {
  threadTitle?: string;
  onTitleChange?: (newTitle: string) => void;
  onBackPress?: () => void;
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
  isLoading?: boolean;
}

export function ThreadHeader({
  threadTitle,
  onTitleChange,
  onBackPress,
  onShare,
  onFiles,
  onDelete,
  isLoading = false,
}: ThreadHeaderProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const [isEditingTitle, setIsEditingTitle] = React.useState(false);
  const [editedTitle, setEditedTitle] = React.useState(threadTitle || '');
  const [isUpdating, setIsUpdating] = React.useState(false);
  const [isActionsDrawerOpen, setIsActionsDrawerOpen] = React.useState(false);
  const titleInputRef = React.useRef<TextInput>(null);

  const backScale = useSharedValue(1);
  const moreScale = useSharedValue(1);

  const backAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: backScale.value }],
  }));

  const moreAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: moreScale.value }],
  }));

  React.useEffect(() => {
    if (threadTitle && threadTitle.trim()) {
      setEditedTitle(threadTitle);
    } else {
      setEditedTitle('');
    }
  }, [threadTitle]);

  const handleBackPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onBackPress?.();
  };

  const handleTitlePress = () => {
    setIsEditingTitle(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTimeout(() => {
      titleInputRef.current?.focus();
    }, 100);
  };

  const handleTitleBlur = async () => {
    setIsEditingTitle(false);

    if (editedTitle !== threadTitle && editedTitle.trim()) {
      setIsUpdating(true);
      try {
        await onTitleChange?.(editedTitle.trim());
      } catch (error) {
        log.error('Failed to update thread title:', error);
        setEditedTitle(threadTitle || '');
      } finally {
        setIsUpdating(false);
      }
    } else {
      setEditedTitle(threadTitle || '');
    }
  };

  const handleMorePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsActionsDrawerOpen(true);
  };

  const handleCloseActionsDrawer = React.useCallback(() => {
    setIsActionsDrawerOpen(false);
  }, []);

  const displayTitle = threadTitle && threadTitle.trim() 
    ? threadTitle 
    : '';

  return (
    <View
      className="absolute top-0 left-0 right-0 bg-background border-b border-border/20"
      style={{
        paddingTop: Math.max(insets.top, 16) + 8,
        zIndex: 50,
      }}
    >
      {/* Header Content */}
      <View className="px-4 pb-3 flex-row items-center gap-3">
        {/* Back Button */}
        <AnimatedPressable
          onPressIn={() => {
            backScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
          }}
          onPressOut={() => {
            backScale.value = withSpring(1, { damping: 15, stiffness: 400 });
          }}
          onPress={handleBackPress}
          style={backAnimatedStyle}
          className="w-8 h-8 items-center justify-center rounded-full"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('threadHeader.goBack')}
        >
          <Icon
            as={ChevronLeft}
            size={24}
            className="text-foreground"
            strokeWidth={2}
          />
        </AnimatedPressable>

        {/* Title Section */}
        <View className="flex-1 flex-row items-center">
          {isEditingTitle ? (
            <View className="flex-1 flex-row items-center gap-2">
              <TextInput
                ref={titleInputRef}
                value={editedTitle}
                onChangeText={setEditedTitle}
                onBlur={handleTitleBlur}
                onSubmitEditing={handleTitleBlur}
                className="flex-1 text-xl font-roobert-medium text-foreground tracking-tight"
                placeholder={t('threadHeader.enterTitle')}
                placeholderTextColor={isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)'}
                selectTextOnFocus
                maxLength={50}
                returnKeyType="done"
                blurOnSubmit
                multiline={false}
                numberOfLines={1}
              />
              <Pressable
                onPress={handleTitleBlur}
                className="w-7 h-7 items-center justify-center rounded-full bg-primary/15"
                hitSlop={8}
              >
                <Icon as={Check} size={14} className="text-primary" strokeWidth={3} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={handleTitlePress}
              className="flex-1"
              hitSlop={8}
            >
              <Text
                className="text-xl font-roobert-medium text-foreground tracking-tight"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {displayTitle}
              </Text>
            </Pressable>
          )}

          {(isUpdating || isLoading) && (
            <View className="ml-2">
              <KortixLoader size="large" />
            </View>
          )}
        </View>

        {/* More Button */}
        {!isEditingTitle && (
          <AnimatedPressable
            onPressIn={() => {
              moreScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              moreScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleMorePress}
            style={moreAnimatedStyle}
            className="w-8 h-8 items-center justify-center rounded-full"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('threadHeader.threadActions')}
          >
            <Icon
              as={MoreHorizontal}
              size={20}
              className="text-foreground"
              strokeWidth={2}
            />
          </AnimatedPressable>
        )}
      </View>

      <ThreadActionsDrawer
        isOpen={isActionsDrawerOpen}
        onClose={handleCloseActionsDrawer}
        onShare={onShare}
        onFiles={onFiles}
        onDelete={onDelete}
      />
    </View>
  );
}
