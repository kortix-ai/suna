import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface SettingsHeaderProps {
  title: string;
  onClose: () => void;
  disabled?: boolean;
  variant?: 'back' | 'close';
}

/**
 * SettingsHeader Component
 * 
 * Consistent header for all settings pages with back arrow and title.
 */
export function SettingsHeader({ title, onClose, disabled = false, variant = 'back' }: SettingsHeaderProps) {
  const insets = useSafeAreaInsets();
  const topPadding = variant === 'close'
    ? Math.max(insets.top, 16) + 16
    : Math.max(insets.top, 16) + 32;

  const handleClose = () => {
    if (disabled) return;
    console.log(`🎯 Header ${variant} button pressed`);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  return (
    <View
      className="px-6 pb-6 flex-row items-center gap-3"
      style={{ paddingTop: topPadding }}
    >
      <Pressable
        onPress={handleClose}
        className="w-8 h-8 items-center justify-center rounded-full p-2"
        hitSlop={8}
        disabled={disabled}
      >
        <Icon
          as={variant === 'close' ? X : ArrowLeft}
          size={24}
          className="text-foreground"
          strokeWidth={2}
        />
      </Pressable>

      <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
        {title}
      </Text>
    </View>
  );
}

