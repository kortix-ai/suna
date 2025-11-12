import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface SettingsHeaderProps {
  title: string;
  onClose: () => void;
  disabled?: boolean;
}

/**
 * SettingsHeader Component
 * 
 * Consistent header for all settings pages with back arrow and title.
 */
export function SettingsHeader({ title, onClose, disabled = false }: SettingsHeaderProps) {
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 16) + 32; // At least 16px safe area + 32px for status bar
  
  const handleClose = () => {
    if (disabled) return;
    console.log('🎯 Header back button pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  return (
    <View 
      className="px-6 pb-8 flex-row items-center gap-3"
      style={{ paddingTop: topPadding }}
    >
      <Pressable
        onPress={handleClose}
        className="w-8 h-8 items-center justify-center bg-primary/10 rounded-full p-2"
        hitSlop={8}
        disabled={disabled}
      >
        <Icon as={ArrowLeft} size={24} className="text-foreground" strokeWidth={2} />
      </Pressable>
      
      <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
        {title}
      </Text>
    </View>
  );
}

