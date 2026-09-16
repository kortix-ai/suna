/**
 * FloatingMenuButton — the floating hamburger at the top left of the project
 * screens without a header bar: project home, a thread, and a connecting
 * session. It opens the project drawer (every project page shows it).
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MenuButton } from '@/components/kortix/menu-button';

export function FloatingMenuButton({ onPress }: { onPress?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="absolute left-4 z-10" style={{ top: insets.top + 8 }} pointerEvents="box-none">
      <MenuButton onPress={onPress} />
    </View>
  );
}
