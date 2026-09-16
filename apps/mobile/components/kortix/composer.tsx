/**
 * Composer — the project home's chat input. One card: the text field on top,
 * one control row underneath (add files · model · send).
 *
 * No border, no animation, a plain placeholder. Light mode is `bg-background`
 * with the floating tab bar's soft shadow; dark mode is `bg-card`, which
 * already separates from the page. Every control is a design-system `Button`:
 * secondary `rounded-full` for add and model, and a round send button that
 * fills with `primary` once there is text or a file to send. Text is 16pt
 * Roobert Regular (design.md §3 Inputs).
 */
import * as React from 'react';
import { Image, ScrollView, TextInput, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ArrowUp, FileText, Plus, X } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { INPUT_FONT_FAMILY, INPUT_FONT_SIZE } from '@/components/kortix/pill-input';
import { LIGHT_SHADOW } from '@/components/navigation/FloatingTabBar';
import type { AttachedFile } from '@/lib/session/attachments';
import { THEME } from '@/lib/utils/theme';
import { cn } from '@/lib/utils/utils';
import { StopIcon } from './StopIcon';

/** About seven lines of 16pt text, then the field scrolls. */
const MAX_INPUT_HEIGHT = 160;

interface ComposerProps {
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** Locks every control, e.g. while a send is in flight. */
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
  autoFocus?: boolean;
  attachments?: AttachedFile[];
  /** Shows the add button. */
  onAttach?: () => void;
  onRemoveAttachment?: (index: number) => void;
  /** Shows the model pill with this text. */
  modelLabel?: string | null;
  onModelPress?: () => void;
  className?: string;
}

export function Composer({
  value,
  onChangeText,
  onSubmit,
  placeholder = 'Ask anything',
  disabled = false,
  busy,
  onStop,
  autoFocus,
  attachments = [],
  onAttach,
  onRemoveAttachment,
  modelLabel,
  onModelPress,
  className,
}: ComposerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const colors = THEME[isDark ? 'dark' : 'light'];
  const canSend = !disabled && (value.trim().length > 0 || attachments.length > 0);

  return (
    <View
      className={cn('rounded-3xl p-2', isDark ? 'bg-card' : 'bg-background', className)}
      style={isDark ? undefined : { boxShadow: LIGHT_SHADOW }}>
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          className="flex-grow-0"
          contentContainerStyle={{ gap: 8 }}>
          {attachments.map((file, index) => (
            <AttachmentChip
              key={`${file.uri}-${index}`}
              file={file}
              disabled={disabled}
              onRemove={() => onRemoveAttachment?.(index)}
            />
          ))}
        </ScrollView>
      ) : null}

      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        multiline
        editable={!disabled}
        autoFocus={autoFocus}
        accessibilityLabel={placeholder}
        className="text-foreground"
        style={{
          fontFamily: INPUT_FONT_FAMILY,
          fontSize: INPUT_FONT_SIZE,
          // 4pt here + the card's 8pt (p-2) = 12pt above the text.
          minHeight: 40,
          maxHeight: MAX_INPUT_HEIGHT,
          paddingHorizontal: 8,
          paddingTop: 4,
          paddingBottom: 12,
          textAlignVertical: 'top',
        }}
      />

      <View className="flex-row items-center gap-2">
        {onAttach ? (
          <Button
            variant="secondary"
            size="icon"
            className="rounded-full"
            onPress={onAttach}
            disabled={disabled}
            accessibilityLabel="Add photos or files">
            <Icon as={Plus} size={20} />
          </Button>
        ) : null}
        {modelLabel ? (
          <Button
            variant="secondary"
            className="shrink rounded-full"
            onPress={onModelPress}
            disabled={disabled}
            accessibilityLabel={`Model, ${modelLabel}`}>
            <Text numberOfLines={1}>{modelLabel}</Text>
          </Button>
        ) : null}
        <View className="flex-1" />
        {busy ? (
          <Button variant="secondary" size="icon" className="rounded-full" onPress={onStop} accessibilityLabel="Stop">
            <StopIcon size={14} className="text-foreground" />
          </Button>
        ) : (
          <Button
            variant={canSend ? 'default' : 'secondary'}
            size="icon"
            className="rounded-full"
            onPress={onSubmit}
            disabled={!canSend}
            accessibilityLabel="Send">
            <Icon as={ArrowUp} size={20} />
          </Button>
        )}
      </View>
    </View>
  );
}

/** One picked file: thumbnail (or file icon) · name · remove. */
function AttachmentChip({
  file,
  disabled,
  onRemove,
}: {
  file: AttachedFile;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <View className="h-12 max-w-56 flex-row items-center gap-2 rounded-2xl bg-secondary pl-1">
      {file.isImage ? (
        <Image source={{ uri: file.uri }} className="h-10 w-10 rounded-xl" />
      ) : (
        <View className="h-10 w-10 items-center justify-center">
          <Icon as={FileText} size={18} className="text-muted-foreground" />
        </View>
      )}
      <Text variant="small" numberOfLines={1} className="shrink">
        {file.name}
      </Text>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        onPress={onRemove}
        disabled={disabled}
        accessibilityLabel={`Remove ${file.name}`}>
        <Icon as={X} size={16} className="text-muted-foreground" />
      </Button>
    </View>
  );
}
