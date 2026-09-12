/**
 * SearchListHeader — the standard "search input + add button" row that sits
 * under PageHeader on list-style pages (Triggers, Channels, etc.). Single
 * source of truth for sizing, padding, and pill radii so every page using it
 * looks identical.
 */

import * as React from 'react';
import { Pressable, View, type TextInputProps } from 'react-native';
import { Plus, Search, X } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

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
  // No top padding on the row below — PageHeader (12) + PageContent (4)
  // already provide the uniform 16pt gap below the title row.
  return (
    <View className="flex-row items-center gap-2.5 px-5 pb-2">
      <View className="h-[42px] flex-1 flex-row items-center rounded-full bg-primary/5 px-4">
        <Icon as={Search} size={16} className="text-muted-foreground" />
        <Input
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          {...inputProps}
          className="ml-2 h-full flex-1 rounded-none border-0 bg-transparent px-0 text-[15px] shadow-none"
        />
        {value.length > 0 && (
          <Pressable onPress={() => onChangeText('')} hitSlop={10}>
            <Icon as={X} size={16} className="text-muted-foreground" />
          </Pressable>
        )}
      </View>
      {rightAction ?? (onAdd && (
        <Button
          variant="default"
          size="icon"
          onPress={onAdd}
          className="h-[42px] w-[42px] rounded-full"
        >
          <Icon as={Plus} size={20} className="text-primary-foreground" />
        </Button>
      ))}
    </View>
  );
}
