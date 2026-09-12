import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import * as Haptics from 'expo-haptics';
import { Share, FolderOpen, Trash2, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { View, Pressable, Modal, TouchableWithoutFeedback, Platform } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInUp, SlideOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLanguage } from '@/contexts/LanguageContext';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface ThreadActionsMenuProps {
  visible: boolean;
  onClose: () => void;
  onShare?: () => void;
  onFiles?: () => void;
  onDelete?: () => void;
}

interface ActionItemProps {
  icon: any;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

function ActionItem({ icon, label, onPress, destructive = false }: ActionItemProps) {
  const { colorScheme } = useColorScheme();
  const [isPressed, setIsPressed] = React.useState(false);

  const handlePressIn = () => {
    setIsPressed(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePressOut = () => {
    setIsPressed(false);
  };

  const handlePress = () => {
    onPress();
  };

  const textClass = destructive ? 'text-destructive' : 'text-foreground';

  return (
    <Pressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      className={`flex-row items-center gap-3 px-4 py-3.5 ${isPressed ? 'bg-hover' : 'bg-transparent'}`}
      android_ripple={{
        color: colorScheme === 'dark'
          ? withAlpha(THEME.dark.foreground, 0.08)
          : withAlpha(THEME.light.foreground, 0.05),
        borderless: false,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        as={icon}
        size={20}
        className={textClass}
        strokeWidth={2.5}
      />
      <Text
        className={`font-roobert-medium text-[15px] flex-1 leading-5 ${textClass}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * ThreadActionsMenu Component
 * 
 * Elegant dropdown menu for thread actions with smooth animations
 * and refined visual design.
 */
export function ThreadActionsMenu({
  visible,
  onClose,
  onShare,
  onFiles,
  onDelete,
}: ThreadActionsMenuProps) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={handleClose}>
        <Animated.View 
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          className="flex-1 bg-black/50"
        >
          <TouchableWithoutFeedback>
            <Animated.View
              entering={SlideInUp.duration(250).springify()}
              exiting={SlideOutUp.duration(200)}
              className="bg-popover"
              style={{
                position: 'absolute',
                top: Math.max(insets.top, 16) + 60,
                right: 16,
                minWidth: 240,
                maxWidth: 280,
                borderRadius: 16,
                overflow: 'hidden',
                ...Platform.select({
                  ios: {
                    shadowColor: '#000', // hex-allowlist: iOS shadow is always cast in pure black; opacity below carries the theme.
                    shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.3,
                    shadowRadius: 16,
                  },
                  android: {
                    elevation: 12,
                  },
                }),
              }}
            >
              {/* Header */}
              <View
                className="flex-row items-center justify-between border-b border-border px-4 py-3.5"
              >
                <Text
                  className="font-roobert-semibold text-[13px] uppercase tracking-wide text-muted-foreground"
                >
                  {t('threadActions.title')}
                </Text>
                <Pressable
                  onPress={handleClose}
                  hitSlop={10}
                  className="w-7 h-7 items-center justify-center rounded-full bg-muted active:opacity-60"
                >
                  <Icon
                    as={X}
                    size={16}
                    className="text-muted-foreground"
                    strokeWidth={2.5}
                  />
                </Pressable>
              </View>

              {/* Actions */}
              <View className="py-1.5">
                {onShare && (
                  <ActionItem
                    icon={Share}
                    label={t('threadActions.shareThread')}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      onShare();
                      handleClose();
                    }}
                  />
                )}

                {onFiles && (
                  <ActionItem
                    icon={FolderOpen}
                    label={t('threadActions.manageFiles')}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      onFiles();
                      handleClose();
                    }}
                  />
                )}

                {onDelete && (
                  <>
                    <View
                      className="mx-3 my-1.5 h-px bg-border"
                    />
                    <ActionItem
                      icon={Trash2}
                      label={t('threadActions.deleteThread')}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        onDelete();
                        handleClose();
                      }}
                      destructive
                    />
                  </>
                )}
              </View>
            </Animated.View>
          </TouchableWithoutFeedback>
        </Animated.View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

