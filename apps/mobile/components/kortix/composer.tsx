/**
 * Composer — the chat input of the project home and of a thread
 * (`SessionChatInput` wraps it). One card: the text field on top, one control
 * row underneath (add · model · send).
 *
 * The card is the page colour, `bg-background`, in both themes (Jay,
 * 2026-09-21: never `bg-card` — a second shade under the text reads as a
 * different surface). A hairline `border-border` separates it from the page in
 * both themes. No shadow (Jay, 2026-09-21): the floating tab bar's soft shadow
 * put a grey halo around the card, so the input read darker than the page.
 * No animation, a plain placeholder. Every control is a design-system
 * `Button`: secondary `rounded-full` for add and model, and a round send
 * button that fills with `primary` once there is text or a file to send. Text
 * is 16pt Roobert Regular (design.md §3 Inputs).
 */
import * as React from 'react';
import {
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { ArrowUpIcon as ArrowUp, CaretDownIcon as CaretDown, PlusIcon as Plus } from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { INPUT_FONT_FAMILY, INPUT_FONT_SIZE } from '@/components/kortix/pill-input';
import type { AttachedFile } from '@/lib/session/attachments';
import { THEME } from '@/lib/utils/theme';
import { cn } from '@/lib/utils/utils';
import { StopIcon } from './StopIcon';
import { ComposerAttachmentTiles } from '@/components/session/composer-attachment-tiles';

/** About seven lines of 16pt text, then the field scrolls. */
const MAX_INPUT_HEIGHT = 160;

interface ComposerProps {
  value: string;
  onChangeText: (t: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** Locks every control, e.g. while a send is in flight. */
  disabled?: boolean;
  /**
   * The agent is working: the row shows Stop. With something to send it shows
   * Stop and Send, and `onSubmit` decides what a send means (the thread queues it).
   */
  busy?: boolean;
  onStop?: () => void;
  autoFocus?: boolean;
  maxLength?: number;
  inputRef?: React.Ref<TextInput>;
  onSelectionChange?: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  /** Inside the card, above the files and the text: the thread's queue and staged command. */
  header?: React.ReactNode;
  /** In the control row after the model pill: the thread's AutoContinue state. */
  accessory?: React.ReactNode;
  attachments?: AttachedFile[];
  /** Shows the add button. */
  onAttach?: () => void;
  /** Spoken name of the add button when it opens more than the file chooser. */
  attachLabel?: string;
  /** Send is enabled with no text and no files (the thread's staged slash command). */
  allowEmptySend?: boolean;
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
  maxLength,
  inputRef,
  onSelectionChange,
  header,
  accessory,
  attachments = [],
  onAttach,
  attachLabel = 'Add photos or files',
  allowEmptySend = false,
  onRemoveAttachment,
  modelLabel,
  onModelPress,
  className,
}: ComposerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const colors = THEME[isDark ? 'dark' : 'light'];
  const canSend = !disabled && (allowEmptySend || value.trim().length > 0 || attachments.length > 0);

  return (
    <View className={cn('rounded-3xl border border-border bg-background p-2', className)}>
      {header ? <View className="px-2 pb-1 pt-1">{header}</View> : null}

      {attachments.length > 0 ? (
        <View className="pb-1">
          <ComposerAttachmentTiles
            files={attachments}
            disabled={disabled}
            onRemove={(index) => onRemoveAttachment?.(index)}
          />
        </View>
      ) : null}

      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onSelectionChange={onSelectionChange}
        maxLength={maxLength}
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
            accessibilityLabel={attachLabel}>
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
            <Text numberOfLines={1} className="shrink">
              {modelLabel}
            </Text>
            <Icon as={CaretDown} size={14} className="text-muted-foreground" />
          </Button>
        ) : null}
        {accessory}
        <View className="flex-1" />
        {busy ? (
          <Button variant="secondary" size="icon" className="rounded-full" onPress={onStop} accessibilityLabel="Stop">
            <StopIcon size={14} className="text-foreground" />
          </Button>
        ) : null}
        {busy && !canSend ? null : (
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
