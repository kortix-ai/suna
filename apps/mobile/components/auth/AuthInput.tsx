import * as React from 'react';
import { Input } from '@/components/ui/input';
import type { AuthInputProps } from './types';

/**
 * AuthInput Component
 * 
 * Styled text input for authentication forms
 * - Email addresses
 * - Passwords
 * - Other auth fields
 * 
 * Specifications:
 * - Height: 48px
 * - Border radius: 16px
 * - Background: bg-card
 * - Border: border-border
 */
export function AuthInput({
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  autoCapitalize = 'none',
  autoComplete,
  keyboardType = 'default',
  returnKeyType = 'done',
  onSubmitEditing,
  error,
}: AuthInputProps) {
  return (
    <Input
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      secureTextEntry={secureTextEntry}
      autoCapitalize={autoCapitalize}
      autoComplete={autoComplete as any}
      autoCorrect={false}
      keyboardType={keyboardType}
      returnKeyType={returnKeyType}
      onSubmitEditing={onSubmitEditing}
      error={error}
      wrapperClassName="bg-card border border-border"
      inputClassName="text-[15px]"
    />
  );
}

