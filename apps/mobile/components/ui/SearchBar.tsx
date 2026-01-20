import * as React from 'react';
import { Pressable, View, Keyboard } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Search, X } from 'lucide-react-native';
import { Icon } from './icon';
import { Input } from './input';
import { log } from '@/lib/logger';
import { useColorScheme } from 'nativewind';

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
    log.log('🎯 Clear search');
    onClear?.();
    Keyboard.dismiss();
  };

  const content = (
    <>
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
    </>
  );

  return isLiquidGlassAvailable() ? (
    <GlassView
      glassEffectStyle="regular"
      tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'}
      isInteractive
      style={{
        height: 44,
        borderRadius: 24,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        borderWidth: 0.5,
        borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.05)',
      }}
      className={className}>
      {content}
    </GlassView>
  ) : (
    <View
      className={`bg-primary/5 rounded-3xl flex-row items-center px-3 h-12 ${className}`}
      style={{
        borderWidth: 0.5,
        borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)',
      }}>
      {content}
    </View>
  );
}
