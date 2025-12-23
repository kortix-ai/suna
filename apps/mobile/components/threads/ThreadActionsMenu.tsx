import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import * as Haptics from 'expo-haptics';
import { Share, FolderOpen, Trash2, Lock, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { View, Pressable, Modal, TouchableWithoutFeedback, Platform } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInUp, SlideOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBillingContext } from '@/contexts/BillingContext';
import { useRouter } from 'expo-router';
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

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      android_ripple={{ color: colorScheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon
        as={icon}
        size={20}
        color={destructive 
          ? '#ef4444' 
          : colorScheme === 'dark' ? '#f8f8f8' : '#121215'
        }
        strokeWidth={2}
      />
      <Text
        style={{ 
          color: destructive 
            ? '#ef4444' 
            : colorScheme === 'dark' ? '#f8f8f8' : '#121215' 
        }}
        className="font-roobert-medium text-base flex-1"
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * ThreadActionsMenu Component
 * 
 * Simple dropdown menu for thread actions.
 * Uses Modal for proper layering without bottom sheet complexity.
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
  const router = useRouter();
  const { hasFreeTier } = useBillingContext();
  const { t } = useLanguage();

  const handleUpgradePrompt = React.useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onClose();
    router.push('/plans');
  }, [onClose, router]);

  const handleAction = (action: () => void) => {
    action();
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View className="flex-1 bg-black/40">
          <TouchableWithoutFeedback>
            <Animated.View
              entering={SlideInUp.duration(200)}
              exiting={SlideOutUp.duration(150)}
              style={{
                position: 'absolute',
                top: Math.max(insets.top, 16) + 60,
                right: 16,
                minWidth: 220,
                backgroundColor: colorScheme === 'dark' ? '#1c1c1e' : '#ffffff',
                borderRadius: 14,
                overflow: 'hidden',
                ...Platform.select({
                  ios: {
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.25,
                    shadowRadius: 12,
                  },
                  android: {
                    elevation: 8,
                  },
                }),
              }}
            >
              {/* Header */}
              <View 
                className="flex-row items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: colorScheme === 'dark' ? '#2c2c2e' : '#e5e5e5' }}
              >
                <Text
                  style={{ color: colorScheme === 'dark' ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.6)' }}
                  className="font-roobert-medium text-sm"
                >
                  {t('threadActions.title')}
                </Text>
                <Pressable 
                  onPress={onClose}
                  hitSlop={8}
                  className="active:opacity-70"
                >
                  <Icon 
                    as={X} 
                    size={18} 
                    color={colorScheme === 'dark' ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.6)'} 
                  />
                </Pressable>
              </View>

              {/* Actions */}
              <View className="py-1">
                {onShare && (
                  <ActionItem
                    icon={hasFreeTier ? Lock : Share}
                    label={hasFreeTier ? t('threadActions.shareThreadUpgrade') : t('threadActions.shareThread')}
                    onPress={() => {
                      if (hasFreeTier) {
                        handleUpgradePrompt();
                      } else {
                        handleAction(onShare);
                      }
                    }}
                  />
                )}

                {onFiles && (
                  <ActionItem
                    icon={FolderOpen}
                    label={t('threadActions.manageFiles')}
                    onPress={() => handleAction(onFiles)}
                  />
                )}

                {onDelete && (
                  <>
                    <View 
                      className="mx-4 my-1 h-px" 
                      style={{ backgroundColor: colorScheme === 'dark' ? '#2c2c2e' : '#e5e5e5' }} 
                    />
                    <ActionItem
                      icon={Trash2}
                      label={t('threadActions.deleteThread')}
                      onPress={() => handleAction(onDelete)}
                      destructive
                    />
                  </>
                )}
              </View>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

