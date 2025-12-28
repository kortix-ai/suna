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

  const iconColor = destructive 
    ? '#ef4444' 
    : colorScheme === 'dark' ? '#f8f8f8' : '#121215';
  
  const textColor = destructive 
    ? '#ef4444' 
    : colorScheme === 'dark' ? '#f8f8f8' : '#121215';

  const backgroundColor = isPressed
    ? colorScheme === 'dark' 
      ? 'rgba(255,255,255,0.05)' 
      : 'rgba(0,0,0,0.03)'
    : 'transparent';

  return (
    <Pressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      className="flex-row items-center gap-3 px-4 py-3.5"
      style={{ backgroundColor }}
      android_ripple={{ 
        color: colorScheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
        borderless: false,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        as={icon}
        size={20}
        color={iconColor}
        strokeWidth={2.5}
      />
      <Text
        style={{ color: textColor }}
        className="font-roobert-medium text-[15px] flex-1 leading-5"
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
  const { colorScheme } = useColorScheme();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  if (!visible) return null;

  const backgroundColor = colorScheme === 'dark' ? '#1c1c1e' : '#ffffff';
  const borderColor = colorScheme === 'dark' ? '#2c2c2e' : '#e5e5e5';
  const separatorColor = colorScheme === 'dark' ? '#2c2c2e' : '#e5e5e5';
  const headerTextColor = colorScheme === 'dark' ? 'rgba(248,248,248,0.65)' : 'rgba(18,18,21,0.65)';

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
              style={{
                position: 'absolute',
                top: Math.max(insets.top, 16) + 60,
                right: 16,
                minWidth: 240,
                maxWidth: 280,
                backgroundColor,
                borderRadius: 16,
                overflow: 'hidden',
                ...Platform.select({
                  ios: {
                    shadowColor: '#000',
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
                className="flex-row items-center justify-between px-4 py-3.5"
                style={{ 
                  borderBottomWidth: 1,
                  borderBottomColor: borderColor,
                }}
              >
                <Text
                  style={{ color: headerTextColor }}
                  className="font-roobert-semibold text-[13px] uppercase tracking-wide"
                >
                  {t('threadActions.title')}
                </Text>
                <Pressable 
                  onPress={handleClose}
                  hitSlop={10}
                  className="w-7 h-7 items-center justify-center rounded-full active:opacity-60"
                  style={{
                    backgroundColor: colorScheme === 'dark' 
                      ? 'rgba(255,255,255,0.08)' 
                      : 'rgba(0,0,0,0.04)',
                  }}
                >
                  <Icon 
                    as={X} 
                    size={16} 
                    color={headerTextColor}
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
                      className="mx-3 my-1.5 h-px" 
                      style={{ backgroundColor: separatorColor }} 
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

