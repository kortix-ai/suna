import * as React from 'react';
import { Pressable, Keyboard, Platform } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { Icon } from './icon';
import { Input } from './input';
import { LiquidGlass } from './liquid-glass';
import { log } from '@/lib/logger';
import { useColorScheme } from 'nativewind';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  onClear?: () => void;
  className?: string;
  colorScheme: any;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder,
  onClear,
  colorScheme,
  className = ""
}: SearchBarProps) {
  const handleClear = () => {
    log.log('🎯 Clear search');
    onClear?.();
    Keyboard.dismiss();
  };

  return (
    <LiquidGlass
      variant="subtle"
      isInteractive
      borderRadius={24}
      elevation={Platform.OS === 'android' ? 3 : 0}
      shadow={{
        color: colorScheme === 'dark' ? '#000000' : '#000000',
        offset: { width: 0, height: 2 },
        opacity: colorScheme === 'dark' ? 0.3 : 0.1,
        radius: 4,
      }}
      style={{
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        borderWidth: 0.5,
        borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
        shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: colorScheme === 'dark' ? 0.3 : 0.1,
        shadowRadius: 4,
      }}
      className={`bg-primary/5 ${className}`}
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
        containerClassName="flex-1 mx-2"
        wrapperClassName="bg-transparent border-0 rounded-none"
        inputClassName="px-0 text-base font-roobert-medium"
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
    </LiquidGlass>
  );
}
