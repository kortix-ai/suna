/**
 * One selection behavior for every message in the transcript (KRTX-607): a
 * long press opens `MessageMenu` (Copy · Select text, plus the time and Edit on
 * a user message); Select text swaps the message for `SelectableMessageText`
 * in place until `SelectTextDoneButton`. `UserMessage` and `TextPartBlock`
 * (assistant prose) both use these three. The rendered message text itself
 * (markdown, inline code, code blocks, math) is never natively selectable.
 *
 * Why no native selection on the rendered text (KRTX-562): on Android a
 * `selectable` root `Text` is a selectable TextView that takes the tap, so a
 * nested link `Text`'s `onPress` never fires. On iOS a selectable `Text` only
 * offers "Copy" of the whole text. So the rendered message keeps its links
 * tappable, and range selection happens in Select text mode.
 */

import { useCallback } from 'react';
import { Platform, TextInput, View, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { TriggerRef } from '@rn-primitives/context-menu';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useToast } from '@/components/kortix/toast-provider';
import { CopyIcon, PencilIcon, TextTIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';
import { userMessageSentLabel } from '@/lib/session/user-message';
import { THEME } from '@/lib/utils/theme';
import { cn } from '@/lib/utils';

/**
 * The message menu, anchored under its message (`relativeTo="trigger"`,
 * bottom; `align` follows the message's side): the time it was sent (user
 * messages), then Copy · Select text · Edit. The components are the RNR
 * `context-menu`; `ContextMenuContent` portals over the thread and closes on a
 * tap outside or an item. The message's own long press opens it through
 * `menuRef.current.open()`.
 */
export function MessageMenu({
  menuRef,
  text,
  timestamp = null,
  edited = false,
  align = 'end',
  onEdit,
  onSelectText,
  children,
}: {
  menuRef: React.RefObject<TriggerRef | null>;
  text: string;
  timestamp?: number | null;
  edited?: boolean;
  /** `end` under a user bubble, `start` under assistant text. */
  align?: 'start' | 'end';
  onEdit?: () => void;
  onSelectText?: () => void;
  children: React.ReactNode;
}) {
  const toast = useToast();
  // Read when the menu renders its content (on open), so "Today" is current.
  const sentLabel = userMessageSentLabel({ timestamp, edited, now: Date.now() });
  const copy = useCallback(async () => {
    await Clipboard.setStringAsync(text);
    haptics.success();
    toast.success('Copied');
  }, [text, toast]);

  return (
    <ContextMenu relativeTo="trigger">
      {/* The trigger only measures the message: the message's own long press
          calls `menuRef.current.open()`. */}
      <ContextMenuTrigger ref={menuRef} asChild>
        <View>{children}</View>
      </ContextMenuTrigger>
      <ContextMenuContent side="bottom" align={align} sideOffset={6} className="min-w-48">
        {sentLabel ? (
          <>
            <ContextMenuLabel className="text-muted-foreground text-xs font-normal">{sentLabel}</ContextMenuLabel>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onPress={() => void copy()}>
          <Icon as={CopyIcon} size={16} className="text-foreground" />
          <Text>Copy</Text>
        </ContextMenuItem>
        {onSelectText ? (
          <ContextMenuItem onPress={onSelectText}>
            <Icon as={TextTIcon} size={16} className="text-foreground" />
            <Text>Select text</Text>
          </ContextMenuItem>
        ) : null}
        {onEdit ? (
          <ContextMenuItem onPress={onEdit}>
            <Icon as={PencilIcon} size={16} className="text-foreground" />
            <Text>Edit</Text>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Select text: the message's source text, selectable in place, in the
 * message's type (`style`: font family, size, line height).
 * Android: a selectable `Text` is a TextView with range selection (a
 * non-editable `TextInput` is disabled there and cannot select). iOS: a
 * selectable `Text` offers only "Copy" of the whole text, so a read-only raw
 * `TextInput` (not `Input`: it is not a field, and `Input` draws one) gives
 * range selection.
 */
export function SelectableMessageText({ text, isDark, style }: { text: string; isDark: boolean; style: TextStyle }) {
  if (Platform.OS === 'ios') {
    return (
      <TextInput
        value={text}
        editable={false}
        multiline
        scrollEnabled={false}
        style={[style, { color: THEME[isDark ? 'dark' : 'light'].foreground, padding: 0 }]}
      />
    );
  }
  return (
    <Text selectable style={style}>
      {text}
    </Text>
  );
}

/** Leaves Select text mode. Sits under the message, on the message's side. */
export function SelectTextDoneButton({ onPress, className }: { onPress: () => void; className?: string }) {
  return (
    <Button variant="ghost" size="sm" className={cn('rounded-full', className)} onPress={onPress}>
      <Text>Done</Text>
    </Button>
  );
}
