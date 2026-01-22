import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KortixLoader, LiquidGlass } from '@/components/ui';
import { BlurFadeHeader } from '@/components/ui/BlurFadeHeader';
import { useLanguage } from '@/contexts';
import * as React from 'react';
import { Pressable, TextInput, View, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import {
  ChevronLeft,
  MoreHorizontal,
  Check,
  Plus,
  PenBox,
} from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { ThreadActionsDrawer } from './ThreadActionsDrawer';
import { log } from '@/lib/logger';
import { router } from 'expo-router';

// Only import ContextMenu on native platforms
let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ThreadHeaderProps {
  threadTitle?: string;
  onTitleChange?: (newTitle: string) => void;
  onBackPress?: () => void;
  onNewChat?: () => void;
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
  isLoading?: boolean;
}

export function ThreadHeader({
  threadTitle,
  onTitleChange,
  onBackPress,
  onNewChat,
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

  const moreScale = useSharedValue(1);

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
    onBackPress?.();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleNewChatPress = () => {
    router.push('/(app)');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleEditTitlePress = () => {
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
    if (Platform.OS === 'android') {
      setIsActionsDrawerOpen(true);
    }
  };

  const handleCloseActionsDrawer = React.useCallback(() => {
    setIsActionsDrawerOpen(false);
  }, []);

  const handleContextMenuPress = React.useCallback((e: any) => {
    const index = e.nativeEvent.index;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    switch (index) {
      case 0:
        handleEditTitlePress();
        break;
      case 1:
        onShare?.();
        break;
      case 2:
        onFiles?.();
        break;
      case 3:
        onDelete?.();
        break;
    }
  }, [onShare, onFiles, onDelete]);

  const displayTitle = threadTitle && threadTitle.trim() 
    ? threadTitle 
    : '';

  return (
    <View
      className="absolute top-0 left-0 right-0"
      style={{
        zIndex: 50,
      }}
    >
      <BlurFadeHeader
        height={Math.max(insets.top, 16) + 60}
        intensity={40}
      />
      <View 
        className="px-4 pb-3"
        style={{
          paddingTop: Math.max(insets.top, 16) + 8,
        }}
      >
        <View className="flex-row items-center justify-between">
          <Pressable
            onPress={handleBackPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('threadHeader.goBack')}
          >
            <LiquidGlass
              variant="card"
              isInteractive
              borderRadius={22}
              elevation={Platform.OS === 'android' ? 3 : 0}
              shadow={{
                color: colorScheme === 'dark' ? '#000000' : '#000000',
                offset: { width: 0, height: 2 },
                opacity: colorScheme === 'dark' ? 0.3 : 0.1,
                radius: 4,
              }}
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: 0.5,
                height: 44,
                width: 44,
                borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
                shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.1,
                shadowRadius: 4,
              }}
            >
              <Icon
                as={ChevronLeft}
                size={24}
                className="text-foreground"
                strokeWidth={2}
              />
            </LiquidGlass>
          </Pressable>
          <View 
            className="absolute left-0 right-0 items-center justify-center"
            style={{
              paddingHorizontal: 56,
              top: 0,
              bottom: 0,
            }}
            pointerEvents={isEditingTitle ? 'auto' : 'box-none'}
          >
            {isEditingTitle ? (
              <View className="flex-row items-center gap-2 w-full">
                <TextInput
                  ref={titleInputRef}
                  value={editedTitle}
                  onChangeText={setEditedTitle}
                  onBlur={handleTitleBlur}
                  onSubmitEditing={handleTitleBlur}
                  className="flex-1 text-lg font-roobert-semibold text-foreground tracking-tight text-center"
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
                  hitSlop={8}
                >
                  <LiquidGlass
                    variant="subtle"
                    borderRadius={16}
                    elevation={Platform.OS === 'android' ? 3 : 0}
                    shadow={{
                      color: colorScheme === 'dark' ? '#000000' : '#000000',
                      offset: { width: 0, height: 2 },
                      opacity: colorScheme === 'dark' ? 0.3 : 0.1,
                      radius: 4,
                    }}
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderWidth: 0.5,
                      height: 44,
                      width: 44,
                      borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
                      shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
                      shadowOffset: { width: 0, height: 2 },
                      shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.1,
                      shadowRadius: 4,
                    }}
                  >
                    <Icon as={Check} size={14} className="text-primary" strokeWidth={3} />
                  </LiquidGlass>
                </Pressable>
              </View>
            ) : (
              <View className="flex-row items-center gap-2">
                <Text
                  className="text-lg font-roobert-semibold text-foreground tracking-tight"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {displayTitle}
                </Text>
                {(isUpdating || isLoading) && (
                  <KortixLoader size="large" />
                )}
              </View>
            )}
          </View>
          {!isEditingTitle ? (
            <LiquidGlass
              variant="card"
              borderRadius={20}
              elevation={Platform.OS === 'android' ? 3 : 0}
              shadow={{
                color: colorScheme === 'dark' ? '#000000' : '#000000',
                offset: { width: 0, height: 2 },
                opacity: colorScheme === 'dark' ? 0.3 : 0.1,
                radius: 4,
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: 40,
                paddingHorizontal: 2,
                gap: 2,
                borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
                shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.1,
                shadowRadius: 4,
              }}
            >
              <Pressable
                onPress={handleNewChatPress}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('threadHeader.newChat')}
              >
                <View
                  style={{
                    justifyContent: 'center',
                    alignItems: 'center',
                    width: 36,
                    height: 36,
                  }}
                >
                  <Icon
                    as={PenBox}
                    size={20}
                    className="text-foreground"
                    strokeWidth={2}
                  />
                </View>
              </Pressable>
              
              {Platform.OS === 'ios' && ContextMenu ? (
                <ContextMenu
                  actions={[
                    { title: t('threadActions.editTitle'), systemIcon: 'pencil' },
                    { title: t('threadActions.share'), systemIcon: 'square.and.arrow.up' },
                    { title: t('threadActions.files'), systemIcon: 'folder' },
                    { title: t('threadActions.delete'), systemIcon: 'trash', destructive: true },
                  ]}
                  onPress={handleContextMenuPress}
                  dropdownMenuMode={true}
                >
                  <AnimatedPressable
                    onPressIn={() => {
                      moreScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                    }}
                    onPressOut={() => {
                      moreScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                    }}
                    style={moreAnimatedStyle}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('threadHeader.threadActions')}
                  >
                    <View
                      style={{
                        justifyContent: 'center',
                        alignItems: 'center',
                        width: 44,
                        height: 44,
                      }}
                    >
                      <Icon
                        as={MoreHorizontal}
                        size={20}
                        className="text-foreground"
                        strokeWidth={2}
                      />
                    </View>
                  </AnimatedPressable>
                </ContextMenu>
              ) : (
                <AnimatedPressable
                  onPressIn={() => {
                    moreScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    moreScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  onPress={handleMorePress}
                  style={moreAnimatedStyle}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('threadHeader.threadActions')}
                >
                  <View
                    style={{
                      justifyContent: 'center',
                      alignItems: 'center',
                      width: 44,
                      height: 44,
                    }}
                  >
                    <Icon
                      as={MoreHorizontal}
                      size={20}
                      className="text-foreground"
                      strokeWidth={2}
                    />
                  </View>
                </AnimatedPressable>
              )}
            </LiquidGlass>
          ) : null}
          {isEditingTitle && (
            <View style={{ width: 88, height: 40 }} />
          )}
        </View>
      </View>

      {Platform.OS === 'android' && (
        <ThreadActionsDrawer
          isOpen={isActionsDrawerOpen}
          onClose={handleCloseActionsDrawer}
          onEditTitle={handleEditTitlePress}
          onShare={onShare}
          onFiles={onFiles}
          onDelete={onDelete}
        />
      )}
    </View>
  );
}
