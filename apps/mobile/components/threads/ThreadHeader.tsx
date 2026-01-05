import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import {
  Menu,
  Share2,
  FolderOpen,
  Trash2,
  MoreVertical,
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
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThreadHeaderProps {
  threadTitle?: string;
  onTitleChange?: (newTitle: string) => void;
  onMenuPress?: () => void; // Changed from onBackPress to onMenuPress
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
  isLoading?: boolean;
}

interface ActionButtonProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

const ActionButton = React.memo(function ActionButton({
  icon,
  label,
  onPress,
  destructive = false,
}: ActionButtonProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center gap-3 px-5 py-3 active:bg-neutral-100 dark:active:bg-neutral-800"
    >
      <Icon 
        as={icon} 
        size={20} 
        className={destructive ? "text-red-500" : "text-neutral-900 dark:text-neutral-100"} 
        strokeWidth={2} 
      />
      <Text 
        className={`font-roobert-medium text-base ${destructive ? "text-red-500" : "text-neutral-900 dark:text-neutral-100"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
});

export function ThreadHeader({
  threadTitle,
  onTitleChange,
  onMenuPress, // Changed from onBackPress
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

  const menuScale = useSharedValue(1);
  const moreScale = useSharedValue(1);

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: menuScale.value }],
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

  const handleMenuPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onMenuPress?.();
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
    : t('threadHeader.untitled');

  return (
    <>
      {/* Full-screen backdrop - closes menu when tapped outside */}
      {showActions && (
        <Pressable
          className="absolute inset-0"
          onPress={() => setShowActions(false)}
          style={{ 
            position: 'absolute',
            top: 0, 
            bottom: 0, 
            left: 0, 
            right: 0,
            zIndex: 49, // Just below the header (which has z-50)
          }}
        />
      )}

      <View 
        className="absolute top-0 left-0 right-0 bg-background z-50"
      >
        {/* Main Header Bar */}
        <View
          className="px-5 flex-row items-center gap-5"
          style={{
            paddingTop: insets.top + 16,
            paddingBottom: 24,
          }}
        >
          {/* Menu Button (Left Icon) */}
          <AnimatedPressable
            onPressIn={() => {
              menuScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
            }}
            onPressOut={() => {
              menuScale.value = withSpring(1, { damping: 15, stiffness: 400 });
            }}
            onPress={handleMenuPress}
            style={menuAnimatedStyle}
            className="w-6 h-6 items-center justify-center"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('threadHeader.openMenu')}
          >
            <Icon
              as={Menu}
              size={24}
              className="text-neutral-900 dark:text-neutral-100"
              strokeWidth={2}
            />
          </AnimatedPressable>

          {/* Title Section (Center) */}
          <View className="flex-1">
            {isEditingTitle ? (
              <View className="flex-row items-center gap-2">
                <TextInput
                  ref={titleInputRef}
                  value={editedTitle}
                  onChangeText={setEditedTitle}
                  onBlur={handleTitleBlur}
                  onSubmitEditing={handleTitleBlur}
                  className="flex-1 text-lg font-roobert-medium text-neutral-900 dark:text-neutral-100"
                  placeholder={t('threadHeader.enterTitle')}
                  placeholderTextColor={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'}
                  selectTextOnFocus
                  maxLength={100}
                  returnKeyType="done"
                  blurOnSubmit
                  multiline={false}
                  numberOfLines={1}
                />
                <Pressable
                  onPress={handleTitleBlur}
                  className="w-6 h-6 items-center justify-center rounded-full bg-primary/15"
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
                  className="text-lg font-roobert-medium text-neutral-900 dark:text-neutral-100"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {displayTitle}
                </Text>
              </Pressable>
            )}
          </View>

          {/* More Button (Right Icon) */}
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
              className="w-6 h-6 items-center justify-center"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={showActions ? t('common.close') : t('threadHeader.threadActions')}
            >
              <Icon
                as={showActions ? X : MoreVertical}
                size={24}
                className="text-neutral-900 dark:text-neutral-100"
                strokeWidth={2}
              />
            </AnimatedPressable>
          )}
        </View>

        {/* Dropdown Actions Menu - Right Aligned */}
        {showActions && (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="absolute right-4"
      style={{
        top: insets.top + 24 + 24 + 12, // paddingTop + bottom padding + gap
        width: 144,
        zIndex: 51, // Above both backdrop and header

        // iOS Shadow
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: isDark ? 0.4 : 0.15,
        shadowRadius: 12,

        // Android Shadow
        elevation: 8,

        // Required for iOS shadow
        backgroundColor: isDark ? '#262626' : '#FFFFFF',
        borderRadius: 16,
      }}
    >
      {/* Inner container clips content but NOT shadow */}
      <View className="rounded-2xl overflow-hidden py-2 bg-background dark:bg-neutral-800">
        {onShare && (
          <ActionButton
            icon={Share2}
            label={t('threadActions.share')}
            onPress={() => {
              setShowActions(false);
              onShare();
            }}
          />
        )}

        {onFiles && (
          <ActionButton
            icon={FolderOpen}
            label={t('threadActions.files')}
            onPress={() => {
              setShowActions(false);
              onFiles();
            }}
          />
        )}

        {onDelete && (
          <ActionButton
            icon={Trash2}
            label={t('threadActions.delete')}
            onPress={handleDelete}
            destructive
          />
        )}
      </View>
    </Animated.View>
  )}
      </View>
    </>
  );
}
