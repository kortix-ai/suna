/**
 * SearchListHeader — the standard "search input + add button" row that sits
 * under PageHeader on list-style pages (Triggers, Channels, etc.). Single
 * source of truth for sizing, padding, and pill radii so every page using it
 * looks identical.
 */

import * as React from 'react';
import { Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Plus, Search, X } from 'lucide-react-native';
import { useThemeColors } from '@/lib/theme-colors';

export interface SearchListHeaderProps {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  /** Show the standard "+" pill button. Mutually exclusive with `rightAction`. */
  onAdd?: () => void;
  /** Custom right-side button — overrides `onAdd`. Sized 42×42 with pill radius. */
  rightAction?: React.ReactNode;
  /** Optional text-input props (returnKeyType, autoFocus, etc.). */
  inputProps?: Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'placeholderTextColor' | 'style'>;
}

export function SearchListHeader({
  value,
  onChangeText,
  placeholder = 'Search…',
  onAdd,
  rightAction,
  inputProps,
}: SearchListHeaderProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const theme = useThemeColors();

  const fg = isDark ? '#f8f8f8' : '#121215';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const placeholderColor = isDark ? '#71717a' : '#a1a1aa';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 10,
      }}
    >
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: inputBg,
          borderRadius: 9999,
          paddingHorizontal: 16,
          height: 42,
        }}
      >
        <Search size={16} color={placeholderColor} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={placeholderColor}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          {...inputProps}
          style={{
            flex: 1,
            marginLeft: 8,
            fontSize: 15,
            fontFamily: 'Roobert',
            color: fg,
            paddingVertical: 0,
          }}
        />
        {value.length > 0 && (
          <Pressable onPress={() => onChangeText('')} hitSlop={10}>
            <X size={16} color={placeholderColor} />
          </Pressable>
        )}
      </View>
      {rightAction ?? (onAdd && (
        <Pressable
          onPress={onAdd}
          style={{
            width: 42,
            height: 42,
            borderRadius: 9999,
            backgroundColor: theme.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={20} color={theme.primaryForeground} />
        </Pressable>
      ))}
    </View>
  );
}
