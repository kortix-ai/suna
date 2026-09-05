// apps/mobile/components/ui/composer.tsx
import * as React from 'react';
import { View, TextInput, Pressable } from 'react-native';
import { ArrowUp } from 'lucide-react-native';
import { Icon } from './icon';
import { StopIcon } from './StopIcon';
import { cn } from '@/lib/utils/utils';

interface ComposerProps {
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  busy?: boolean;
  onStop?: () => void;
  autoFocus?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
}
export function Composer({
  value,
  onChangeText,
  onSubmit,
  placeholder = 'Ask anything…',
  busy,
  onStop,
  autoFocus,
  leading,
  trailing,
  className,
}: ComposerProps) {
  const canSend = value.trim().length > 0;
  return (
    <View
      className={cn(
        'flex-row items-end gap-2 rounded-2xl bg-input border-[1.5px] border-border px-3 py-2',
        className
      )}>
      {leading}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="hsl(var(--muted-foreground) / 0.6)"
        multiline
        autoFocus={autoFocus}
        className="flex-1 text-foreground"
        style={{ fontFamily: 'Roobert-Regular', fontSize: 16, maxHeight: 140, paddingTop: 6, paddingBottom: 6 }}
      />
      {trailing}
      {busy ? (
        <Pressable onPress={onStop} className="h-8 w-8 rounded-full items-center justify-center bg-foreground">
          <StopIcon size={14} className="text-background" />
        </Pressable>
      ) : (
        <Pressable
          onPress={onSubmit}
          disabled={!canSend}
          style={({ pressed }) => (pressed ? { transform: [{ scale: 0.94 }] } : undefined)}
          className={cn(
            'h-8 w-8 rounded-full items-center justify-center',
            canSend ? 'bg-kortix-blue' : 'bg-foreground/15'
          )}>
          <Icon as={ArrowUp} size={18} className={canSend ? 'text-white' : 'text-muted-foreground'} />
        </Pressable>
      )}
    </View>
  );
}
