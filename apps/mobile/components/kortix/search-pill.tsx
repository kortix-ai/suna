/**
 * SearchPill — the filled, borderless search input pill (40pt, `rounded-full
 * bg-secondary`) holding a 16pt magnifier, the app Input and a clear pressable
 * that shows only when the text is non-empty. Single source of truth for the
 * pill's sizing, padding, and radii; `SearchListHeader` composes it.
 */

import * as React from 'react';
import { Pressable, View } from 'react-native';
import { MagnifyingGlassIcon as Search, XIcon as X } from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';

export function SearchPill({
  value,
  onChangeText,
  placeholder = 'Search…',
  inputProps,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  inputProps?: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChangeText' | 'placeholder'>;
}) {
  return (
    // Filled, borderless pill; the Input inside inherits the app-wide input
    // text (16pt Roobert Regular) and only drops its own surface.
    <View className="h-10 flex-1 flex-row items-center rounded-full bg-secondary px-4">
      <Icon as={Search} size={16} className="text-muted-foreground" />
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        {...inputProps}
        className="ml-2 h-full flex-1 rounded-none bg-transparent px-0"
      />
      {value.length > 0 && (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Clear search">
          <Icon as={X} size={16} className="text-muted-foreground" />
        </Pressable>
      )}
    </View>
  );
}
