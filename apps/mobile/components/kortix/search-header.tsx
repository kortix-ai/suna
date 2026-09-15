/**
 * SearchHeader — the iOS-style search mode for a screen header.
 *
 *   ( 🔍  query            ⓧ )  Cancel
 *
 * A filled pill with a leading magnifier, the text field (focused on mount),
 * a round clear button while there is text, and a Cancel text button that
 * leaves search mode. The screen swaps its normal header row for this one.
 */

import * as React from 'react';
import { Keyboard, TextInput, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Search, X } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { INPUT_FONT_FAMILY, INPUT_FONT_SIZE } from '@/components/kortix/pill-input';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';

export interface SearchHeaderProps {
  value: string;
  onChangeText: (text: string) => void;
  /** Leave search mode. The screen clears its query and restores the header. */
  onCancel: () => void;
  placeholder?: string;
}

export function SearchHeader({
  value,
  onChangeText,
  onCancel,
  placeholder = 'Search',
}: SearchHeaderProps) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];

  const handleCancel = () => {
    haptics.selection();
    Keyboard.dismiss();
    onCancel();
  };

  return (
    <View className="flex-1 flex-row items-center gap-1">
      {/* Filled pill, 40pt tall — the same height as the header's icon buttons,
          so swapping the header in and out never changes its height. */}
      <View className="h-10 flex-1 flex-row items-center rounded-full bg-secondary pl-3.5">
        <Icon as={Search} size={18} className="text-foreground" strokeWidth={2.2} />
        {/* Raw TextInput: the pill owns the border/background, so <Input>'s own
            chrome would have to be overridden class by class. */}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="never"
          accessibilityLabel={placeholder}
          className="ml-2.5 h-full flex-1 text-foreground"
          style={{ fontSize: INPUT_FONT_SIZE, fontFamily: INPUT_FONT_FAMILY }}
        />
        {value.length > 0 ? (
          // iOS-style clear: a small filled circle with a knocked-out ×.
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            accessibilityLabel="Clear search"
            onPress={() => {
              haptics.selection();
              onChangeText('');
            }}>
            <View className="h-5 w-5 items-center justify-center rounded-full bg-muted-foreground/40">
              <Icon as={X} size={12} className="text-background" strokeWidth={3} />
            </View>
          </Button>
        ) : null}
      </View>

      <Button variant="ghost" size="sm" accessibilityLabel="Cancel search" onPress={handleCancel}>
        <Text>Cancel</Text>
      </Button>
    </View>
  );
}
