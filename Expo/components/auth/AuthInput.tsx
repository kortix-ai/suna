import * as React from 'react';
import { TextInput, View } from 'react-native';
import { Text } from '@/components/ui/text';
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
    <View className="w-full">
      <View className="bg-card h-12 rounded-2xl border border-border">
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="hsl(var(--muted-foreground))"
          secureTextEntry={secureTextEntry}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete as any}
          autoCorrect={false}
          keyboardType={keyboardType}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          style={{ fontFamily: 'Roobert-Regular' }}
          className="flex-1 h-full px-4 text-foreground text-[15px]"
        />
      </View>
      {error && (
        <Text className="text-destructive text-sm font-roobert mt-2 px-1">
          {error}
        </Text>
      )}
    </View>
  );
}

