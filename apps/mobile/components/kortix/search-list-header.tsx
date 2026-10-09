/**
 * SearchListHeader — the standard "search input + add button" row that sits
 * under PageHeader on list-style pages (Triggers, Channels, etc.). Single
 * source of truth for sizing, padding, and pill radii so every page using it
 * looks identical.
 */

import * as React from 'react';
import { View, type TextInputProps } from 'react-native';
import { PlusIcon as Plus } from '@/lib/icons';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { SearchPill } from '@/components/kortix/search-pill';

interface SearchListHeaderProps {
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
      <SearchPill value={value} onChangeText={onChangeText} placeholder={placeholder} inputProps={inputProps} />
      {rightAction ?? (onAdd && (
        <Button
          variant="default"
          size="icon"
          onPress={onAdd}
          className="rounded-full"
          accessibilityLabel="Add"
        >
          <Icon as={Plus} size={20} className="text-primary-foreground" />
        </Button>
      ))}
    </View>
  );
}
