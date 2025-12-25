import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import {
  ChevronLeft,
  Share2,
  FolderOpen,
  Trash2,
  MoreHorizontal,
  X,
  Check,
  type LucideIcon,
} from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
  FadeOut,
  SlideInRight,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

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

interface ActionPillProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  delay?: number;
}

const ActionPill = React.memo(function ActionPill({
  icon,
  label,
  onPress,
  destructive = false,
  delay = 0,
}: ActionPillProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.92, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const bgColor = destructive
    ? isDark
      ? 'rgba(239, 68, 68, 0.12)'
      : 'rgba(239, 68, 68, 0.08)'
    : isDark
      ? 'rgba(255, 255, 255, 0.06)'
      : 'rgba(0, 0, 0, 0.04)';

  const textColor = destructive ? '#ef4444' : isDark ? '#f8f8f8' : '#121215';

  return (
    <Animated.View entering={SlideInRight.delay(delay).duration(200).springify()}>
      <AnimatedPressable
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[animatedStyle, { backgroundColor: bgColor }]}
        className="flex-row items-center gap-2 rounded-full px-3.5 py-2"
        hitSlop={4}
      >
        <Icon as={icon} size={16} color={textColor} strokeWidth={2} />
        <Text style={{ color: textColor }} className="font-roobert-medium text-sm">
          {label}
        </Text>
      </AnimatedPressable>
    </Animated.View>
  );
});

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
  const [showActions, setShowActions] = React.useState(false);
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
    if (showActions) {
      setShowActions(false);
      return;
    }
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
        console.error('Failed to update thread title:', error);
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
    setShowActions(!showActions);
  };

  const handleDelete = () => {
    setShowActions(false);
    Alert.alert(
      t('threadActions.deleteThread'),
      t('threadActions.deleteConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: onDelete,
        },
      ]
    );
  };

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

        {/* More/Close Button */}
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
            accessibilityLabel={showActions ? t('common.close') : t('threadHeader.threadActions')}
          >
            <Icon
              as={showActions ? X : MoreHorizontal}
              size={20}
              className="text-foreground"
              strokeWidth={2}
            />
          </AnimatedPressable>
        )}
      </View>

      {/* Expandable Actions Row */}
      {showActions && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          className="px-4 pb-3"
        >
          <View className="flex-row items-center gap-2 flex-wrap">
            {onShare && (
              <ActionPill
                icon={Share2}
                label={t('threadActions.share')}
                onPress={() => {
                  setShowActions(false);
                  onShare();
                }}
                delay={0}
              />
            )}
            {onFiles && (
              <ActionPill
                icon={FolderOpen}
                label={t('threadActions.files')}
                onPress={() => {
                  setShowActions(false);
                  onFiles();
                }}
                delay={40}
              />
            )}
            {onDelete && (
              <ActionPill
                icon={Trash2}
                label={t('threadActions.delete')}
                onPress={handleDelete}
                destructive
                delay={80}
              />
            )}
          </View>
        </Animated.View>
      )}
    </View>
  );
}
