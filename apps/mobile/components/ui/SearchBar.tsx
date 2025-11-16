import * as React from 'react';
import { Pressable, TextInput, View, Keyboard } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Search, X } from 'lucide-react-native';
import { Icon } from './icon';
import { Text } from './text';

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
  const { colorScheme } = useColorScheme();
  
  const handleClear = () => {
    console.log('🎯 Clear search');
    onClear?.();
    Keyboard.dismiss();
  };
  
  return (
    <View 
      className={`bg-primary/5 rounded-3xl flex-row items-center px-3 h-12 ${className}`}
    >
      <Icon 
        as={Search}
        size={18}
        className="text-muted-foreground"
        strokeWidth={2}
      />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.4)' : 'rgba(0, 0, 0, 0.4)'}
        className="flex-1 mx-2 text-base font-roobert-medium text-foreground"
        style={{ fontFamily: 'Roobert-Medium' }}
        returnKeyType="search"
        clearButtonMode="never"
        accessibilityLabel={`Search ${placeholder.toLowerCase()}`}
        accessibilityHint={`Type to search through your ${placeholder.toLowerCase()}`}
      />
      {value.length > 0 && (
        <Pressable
          onPress={handleClear}
          className="w-8 h-8 items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon 
            as={X}
            size={16}
            className="text-muted-foreground"
            strokeWidth={2}
          />
        </Pressable>
      )}
    </View>
  );
}
