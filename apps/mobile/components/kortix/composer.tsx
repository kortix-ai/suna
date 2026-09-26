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
 * button that fills with `primary` once there is text or a file to send. The
 * control row is 36pt (Jay, 2026-09-21: 40pt read oversized): `icon-md` icon
 * buttons with 18pt glyphs, a `sm` model pill. Text is 16pt Roobert Regular
 * (design.md §3 Inputs).
 *
 * Dictation: a ghost mic button before Send. While listening the
 * control row crossfades into Cancel · waveform · Done, and the recogniser
 * writes the words into the text field live (`useDictation`).
 */
import * as React from 'react';
import {
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import Animated, { Easing, FadeIn, FadeOut, LayoutAnimationConfig } from 'react-native-reanimated';
import {
  ArrowUpIcon as ArrowUp,
  CaretDownIcon as CaretDown,
  CheckIcon as Check,
  MicrophoneIcon as Microphone,
  PlusIcon as Plus,
  XIcon as X,
} from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { INPUT_FONT_FAMILY, INPUT_FONT_SIZE } from '@/components/kortix/pill-input';
import type { AttachedFile } from '@/lib/session/attachments';
import { BUTTON_LABEL_MAX_FONT_SCALE } from '@/lib/ui/font-scale';
import { THEME } from '@/lib/utils/theme';
import { cn } from '@/lib/utils/utils';
import { StopIcon } from './StopIcon';
import {
  ComposerAttachmentTiles,
  type ComposerAttachmentUpload,
} from '@/components/session/composer-attachment-tiles';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { DictationWaveform } from '@/components/kortix/dictation-waveform';
import { useDictation } from '@/hooks/useDictation';

/**
 * Added to each side of a 36pt `icon-md` control, so its touch target is 44pt.
 * The row's `gap-2` (8pt) keeps neighbouring targets from overlapping.
 */
export const COMPOSER_CONTROL_HIT_SLOP = 4;

/**
 * The control row and the listening row swap with a crossfade in the same
 * 36pt slot: the new row fades in over 160 ms, the old one out in 120 ms.
 */
const ROW_IN = FadeIn.duration(160).easing(Easing.out(Easing.quad));
const ROW_OUT = FadeOut.duration(120).easing(Easing.out(Easing.quad));
const ROW_LAYER = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;

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
  /** Per-file upload progress ring / failure scrim, keyed by index in `attachments`. */
  attachmentUploads?: Readonly<Record<number, ComposerAttachmentUpload>>;
  /** Shows the model pill with this text. */
  modelLabel?: string | null;
  onModelPress?: () => void;
  className?: string;
  /** A send is in flight: the send slot shows `KortixLoader` instead of the arrow, and stays disabled. */
  sending?: boolean;
  /** Shows the mic button (voice input into the text field). Default on. */
  dictation?: boolean;
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
  attachmentUploads,
  modelLabel,
  onModelPress,
  className,
  sending = false,
  dictation: dictationEnabled = true,
}: ComposerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const colors = THEME[isDark ? 'dark' : 'light'];
  const canSend = !disabled && (allowEmptySend || value.trim().length > 0 || attachments.length > 0);
  const dictation = useDictation({ value, onChangeText });
  const showMic = dictationEnabled && dictation.available;
  // A send or a lock ends dictation, keeping the words.
  const { active: dictating, finish: finishDictation } = dictation;
  React.useEffect(() => {
    if (disabled && dictating) finishDictation();
  }, [disabled, dictating, finishDictation]);

  return (
    <View className={cn('rounded-3xl border border-border bg-background p-2', className)}>
      {header ? <View className="px-2 pb-1 pt-1">{header}</View> : null}

      {attachments.length > 0 ? (
        <View className="pb-1">
          <ComposerAttachmentTiles
            files={attachments}
            disabled={disabled}
            uploads={attachmentUploads}
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
        // Words stream in while listening; typing would fight them.
        editable={!disabled && !dictation.active}
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
          paddingTop: 6,
          paddingBottom: 14,
          textAlignVertical: 'top',
        }}
      />

      {/* skipEntering: the row fades only when it swaps, not when the composer mounts. */}
      <LayoutAnimationConfig skipEntering>
        <View style={{ height: 36 }}>
          {dictation.active ? (
            <Animated.View
              key="listening"
              entering={ROW_IN}
              exiting={ROW_OUT}
              style={ROW_LAYER}
              className="flex-row items-center gap-2">
              <Button
                variant="secondary"
                size="icon-md"
                className="rounded-full"
                hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                onPress={dictation.cancel}
                accessibilityLabel="Cancel dictation">
                <Icon as={X} size={18} />
              </Button>
              <DictationWaveform
                levels={dictation.levels}
                listening={dictation.state === 'listening'}
              />
              <Button
                variant="default"
                size="icon-md"
                className="rounded-full"
                hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                onPress={dictation.finish}
                disabled={dictation.state === 'stopping'}
                accessibilityLabel="Done dictating">
                {dictation.state === 'stopping' ? (
                  <KortixLoader size="small" />
                ) : (
                  <Icon as={Check} size={18} />
                )}
              </Button>
            </Animated.View>
          ) : (
            <Animated.View
              key="controls"
              entering={ROW_IN}
              exiting={ROW_OUT}
              style={ROW_LAYER}
              className="flex-row items-center gap-2">
              {onAttach ? (
                <Button
                  variant="secondary"
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={onAttach}
                  disabled={disabled}
                  accessibilityLabel={attachLabel}>
                  <Icon as={Plus} size={18} />
                </Button>
              ) : null}
              {modelLabel ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={onModelPress}
                  disabled={disabled}
                  accessibilityLabel={`Model, ${modelLabel}`}>
                  <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={BUTTON_LABEL_MAX_FONT_SCALE.sm}
                    className="shrink">
                    {modelLabel}
                  </Text>
                  <Icon as={CaretDown} size={14} className="text-muted-foreground" />
                </Button>
              ) : null}
              {accessory}
              <View className="flex-1" />
              {showMic ? (
                <Button
                  variant="ghost"
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={dictation.start}
                  disabled={disabled}
                  accessibilityLabel="Dictate">
                  <Icon as={Microphone} size={18} />
                </Button>
              ) : null}
              {busy ? (
                <Button
                  variant="secondary"
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={onStop}
                  accessibilityLabel="Stop">
                  <StopIcon size={12} className="text-foreground" />
                </Button>
              ) : null}
              {busy && !canSend ? null : (
                <Button
                  variant={canSend ? 'default' : 'secondary'}
                  size="icon-md"
                  className="rounded-full"
                  hitSlop={COMPOSER_CONTROL_HIT_SLOP}
                  onPress={onSubmit}
                  disabled={!canSend || sending}
                  accessibilityLabel="Send">
                  {sending ? <KortixLoader size="small" /> : <Icon as={ArrowUp} size={18} />}
                </Button>
              )}
            </Animated.View>
          )}
        </View>
      </LayoutAnimationConfig>
    </View>
  );
}
