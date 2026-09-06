import * as React from 'react';
import { View, Keyboard } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { log } from '@/lib/logger';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  onClear?: () => void;
  className?: string;
}

/**
 * SearchBar Component - Reusable search input with clear functionality
 *
 * Features:
 * - Compact design with search icon
 * - Clear button appears when text is entered
 * - Proper keyboard handling
 * - Theme-aware styling
 * - Accessibility support
 * - Customizable placeholder and styling
 */
export function SearchBar({
  value,
  onChangeText,
  placeholder,
  onClear,
  className = ""
}: SearchBarProps) {
  const handleClear = () => {
    log.log('🎯 Clear search');
    onClear?.();
    Keyboard.dismiss();
  };

  return (
    <View
      className={`bg-primary/5 rounded-full flex-row items-center px-4 h-12 ${className}`}
    >
      <Icon
        as={Search}
        size={18}
        className="text-muted-foreground"
        strokeWidth={2}
      />
      <Input
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        returnKeyType="search"
        className="flex-1 mx-2 h-full rounded-none border-0 bg-transparent px-0 text-base shadow-none"
        accessibilityLabel={`Search ${placeholder.toLowerCase()}`}
        accessibilityHint={`Type to search through your ${placeholder.toLowerCase()}`}
      />
      {value.length > 0 && (
        <Button
          variant="ghost"
          size="icon"
          onPress={handleClear}
          className="h-8 w-8"
          accessibilityLabel="Clear search"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon
            as={X}
            size={16}
            className="text-muted-foreground"
            strokeWidth={2}
          />
        </Button>
      )}
    </View>
  );
}
