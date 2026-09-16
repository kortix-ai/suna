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
  /** Side padding: `project` 16pt (`px-4`, default — list pages live in a project), `page` 20pt (`px-5`). */
  gutter?: 'page' | 'project';
}

export function SearchListHeader({
  value,
  onChangeText,
  placeholder = 'Search…',
  onAdd,
  rightAction,
  inputProps,
  gutter = 'project',
}: SearchListHeaderProps) {
  // No top padding on the row below — PageHeader (12) + PageContent (4)
  // already provide the uniform 16pt gap below the title row.
  return (
    <View className={`flex-row items-center gap-2.5 pb-2 ${gutter === 'page' ? 'px-5' : 'px-4'}`}>
      {/* Filled, borderless pill; the Input inside inherits the app-wide input
          text (16pt Roobert Regular) and only drops its own surface. */}
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
      {rightAction ?? (onAdd && (
        <Button
          variant="default"
          size="icon"
          onPress={onAdd}
          className="rounded-full"
        >
          <Icon as={Plus} size={20} className="text-primary-foreground" />
        </Button>
      ))}
    </View>
  );
}
