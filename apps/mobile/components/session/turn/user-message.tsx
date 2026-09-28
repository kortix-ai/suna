/**
 * UserMessage — the user side of a turn. Mirrors apps/web
 * `features/session/turn/user-message.tsx` (`UserMessage`, `UserMessageBubble`,
 * `UserMessageEditor`, `MessageAttachments`). Web's `UserMessageActions` row
 * (time · Edit · Copy) is a long-press menu on mobile instead
 * (`UserMessageMenuSheet`, Jay 2026-09-27).
 *
 * One right-aligned column capped at 80%: attachments → bubble → a queued
 * status line (only while one applies).
 * Pixel values are web's RENDERED values (web spacing is 0.23rem per step, see
 * `webSpace` in `lib/session/user-message.ts`). Pure logic lives in
 * `lib/session/user-message.ts`, `lib/session/mention-segments.ts` and
 * `lib/session/attachment-tile.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, TextInput, View, type LayoutChangeEvent } from 'react-native';
import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import {
  CaretDownIcon,
  CopyIcon,
  PencilIcon,
  TextTIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  SlackLogoIcon,
  TimerIcon,
} from '@/lib/icons';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';
import type { Turn, TextPart } from '@/lib/opencode/types';
import type { Command } from '@/lib/opencode/hooks/use-opencode-data';
import { isTextPart, messageCreatedAt, splitUserParts, type MessageWithParts } from '@kortix/sdk';
import { parseTriggerEvent } from '@kortix/shared';
import { parseLegacyChannelMessage } from '@/lib/session/channel-message';
import { detectCommandFromText } from '@/lib/session/detect-command';
import { formatMegabytes } from '@/lib/session/image-load';
import { buildMentionSegments } from '@/lib/session/mention-segments';
import {
  isPreviewableImage,
  localOrResolvedSource,
  planAttachmentGrid,
} from '@/lib/session/attachment-tile';
import {
  commandMessageText,
  isUserMessageEdited,
  parseUserMessageText,
  queuedPromptStatusLabel,
  quoteMarginBottom,
  userMessageSentLabel,
  webSpace,
  type QueuedPromptState,
} from '@/lib/session/user-message';
import { MentionChip } from '../mention-chip';
import { AttachmentOverflowTile, AttachmentTile } from '../attachment-tile';
import { useSandboxImage } from './use-sandbox-image';
import { haptics } from '@/lib/haptics';
import * as Clipboard from 'expo-clipboard';
import type { TriggerRef } from '@rn-primitives/context-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useToast } from '@/components/kortix/toast-provider';

// ─── Values (web → rendered px) ──────────────────────────────────────────────

/** `text-[0.9rem] leading-[22px] font-medium`. */
const BUBBLE_TEXT_STYLE = { fontFamily: 'Roobert-Medium', fontSize: 14.4, lineHeight: 22 } as const;
/** `px-3.5 py-2.5 rounded-lg`. */
const BUBBLE_PADDING_X = webSpace(3.5);
const BUBBLE_PADDING_Y = webSpace(2.5);
const BUBBLE_RADIUS = 10;
/** `max-h-[200px]`. */
const CLAMP_HEIGHT = 200;
/** `h-10` fade. */
const FADE_HEIGHT = webSpace(10);
/** `text-xs` = 0.8125rem with a 1rem line. */
const META_TEXT_STYLE = { fontSize: 13, lineHeight: 16 } as const;

// Fixed third-party brand marks for channel cards; they must not follow the app theme.
const CHANNEL_BRAND_COLOR = {
  Telegram: 'hsl(198.7 91.9% 56.3%)', // hex-allowlist: Telegram blue, web CHANNEL_BRAND_COLOR.Telegram hsl(198.7 91.9% 56.3%)
  Slack: 'hsl(339.6 82.2% 51.6%)', // hex-allowlist: Slack pink, web CHANNEL_BRAND_COLOR.Slack hsl(339.6 82.2% 51.6%)
} as const;

/** `isDark` is passed down from SessionTurn. */
function paletteFor(isDark: boolean) {
  return THEME[isDark ? 'dark' : 'light'];
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** A failed send's bubble: the queued dim's `opacity-50`. */
const FAILED_BUBBLE_STYLE = { opacity: 0.5 };

/** A failed send the host kept on screen. */
export interface UserMessageUploadStatus {
  state: 'failed';
  /** Why it failed, shown verbatim. */
  message?: string;
  /** Sends the message again. */
  onRetry?: () => void;
}

interface MessageAttachment {
  key: string;
  filename: string;
  mime?: string;
  src?: string;
  /** The picked file on the device (an optimistic send, COR-185): shown until the server echo replaces the message. */
  localUri?: string;
}

// ─── UserMessage ─────────────────────────────────────────────────────────────

export function UserMessage({
  turn,
  isDark,
  agentNames,
  onFileMention,
  onSessionMention,
  commands,
  editingText,
  editPending,
  onEditStart,
  onEditCancel,
  onEditSend,
  rewindDisabled,
  queueState,
  uploadStatus,
}: {
  turn: Turn;
  isDark: boolean;
  agentNames?: string[];
  /** Opens a workspace path (file mention, attachment tile). */
  onFileMention?: (path: string) => void;
  onSessionMention?: (sessionId: string) => void;
  commands?: Command[];
  /** Non-null while THIS message is being edited: the editor replaces the column. */
  editingText?: string | null;
  /** The rewind + resend is on the wire. */
  editPending?: boolean;
  /** Opens the editor on this message with its prompt text. */
  onEditStart?: (messageId: string, text: string) => void;
  onEditCancel?: () => void;
  onEditSend?: (messageId: string, text: string) => void;
  /** Hides Edit (busy session, queued prompts, a rewind in flight). Copy stays. */
  rewindDisabled?: boolean;
  /** Dims the column; `interrupted` also shows a status line. */
  queueState?: QueuedPromptState | null;
  uploadStatus?: UserMessageUploadStatus;
}) {
  const message = turn.userMessage;
  const messageId = message.info.id;

  const parsed = useMemo(() => {
    const { attachments: fileParts, stickyParts } = splitUserParts(message.parts);
    const rawText = stickyParts
      .filter(
        (p) =>
          isTextPart(p) &&
          !!(p as TextPart).text?.trim() &&
          !(p as TextPart & { synthetic?: boolean }).synthetic &&
          !(p as TextPart & { ignored?: boolean }).ignored,
      )
      .map((p) => (p as TextPart).text)
      .join('\n');
    const content = parseUserMessageText(rawText);
    const attachments: MessageAttachment[] = [
      ...content.files.map((f, i) => ({
        key: `upload:${i}:${f.path}`,
        filename: f.filename || f.path.split('/').pop() || 'File',
        mime: f.mime,
        src: f.path || undefined,
      })),
      ...fileParts.map((p) => {
        const fp = p as unknown as { id: string; filename?: string; mime: string; url?: string; localUri?: string };
        return { key: fp.id, filename: fp.filename || 'File', mime: fp.mime, src: fp.url, localUri: fp.localUri };
      }),
    ];
    return { rawText, content, attachments };
  }, [message.parts]);

  const { rawText, content, attachments } = parsed;

  const commandInfo = useMemo(() => detectCommandFromText(rawText, commands), [rawText, commands]);
  // Command args arrive raw; `commandMessageText` strips their quote blocks,
  // which the bubble already draws once from `content.quotes`.
  const commandText = commandInfo ? commandMessageText(commandInfo.name, commandInfo.args) : null;
  const bodyText = commandText ? commandText.body : content.text;

  /** The text the editor starts from and Copy writes. */
  const promptText = commandText ? commandText.prompt : content.text;

  const edited = useMemo(() => isUserMessageEdited(message.parts as never), [message.parts]);
  const timestamp = messageCreatedAt(message as unknown as MessageWithParts);

  // Both parsers are linear in the prompt: a channel or a webhook chooses this
  // text, and a regex version of each froze the JS thread on a crafted prompt.
  const channelMessageInfo = useMemo(() => parseLegacyChannelMessage(rawText), [rawText]);
  const triggerEventInfo = useMemo(() => parseTriggerEvent(rawText), [rawText]);

  // Queued dim: `duration-slow transition-opacity` + `opacity-50`.
  const dim = useSharedValue(queueState ? 0.5 : 1);
  useEffect(() => {
    dim.value = withTiming(queueState ? 0.5 : 1, {
      duration: MOTION.duration.slow,
      easing: Easing.bezier(...MOTION.easing.default),
    });
  }, [queueState, dim]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));

  const statusLabel = queueState ? queuedPromptStatusLabel(queueState) : null;

  // Long press opens the message menu right under the bubble (Jay,
  // 2026-09-27: a sheet pulled the eye away): the time it was sent, then
  // Copy · Select text · Edit. It replaced the "just now · Edit · Copy" row
  // under the bubble; only a queued status line (or Select text's Done)
  // stays there. The bubble's own long press opens it through the trigger's
  // ref: the bubble is already a Pressable (tap expands a long message).
  const canEdit = !!onEditStart && !rewindDisabled && !channelMessageInfo && !triggerEventInfo;
  const menuRef = useRef<TriggerRef>(null);
  // Select text: the bubble's text becomes selectable in place until Done.
  const [selecting, setSelecting] = useState(false);
  const openMenu = useCallback(() => {
    if (!promptText) return;
    haptics.medium();
    menuRef.current?.open();
  }, [promptText]);
  const menuProps = {
    menuRef,
    text: promptText,
    timestamp,
    edited,
    onEdit: canEdit ? () => onEditStart?.(messageId, promptText) : undefined,
  };

  const actions = selecting ? (
    <Button variant="ghost" size="sm" className="rounded-full" onPress={() => setSelecting(false)}>
      <Text>Done</Text>
    </Button>
  ) : statusLabel ? (
    <Text
      variant="muted"
      numberOfLines={1}
      style={[META_TEXT_STYLE, { color: withAlpha(paletteFor(isDark).mutedForeground, 0.7) }]}>
      {statusLabel}
    </Text>
  ) : null;

  // Editing replaces the whole column with the full-width editor.
  if (editingText != null && onEditSend && onEditCancel) {
    return (
      <View className="px-4">
        <UserMessageEditor
          isDark={isDark}
          initialText={editingText}
          pending={editPending}
          onCancel={onEditCancel}
          onSend={(text) => onEditSend(messageId, text)}
        />
      </View>
    );
  }

  if (channelMessageInfo) {
    const brand = CHANNEL_BRAND_COLOR[channelMessageInfo.platform] ?? CHANNEL_BRAND_COLOR.Slack;
    return (
      <Reanimated.View className="px-4" style={dimStyle}>
        <View className="items-end" style={{ gap: webSpace(1) }}>
          <MessageMenu {...menuProps}>
          <Pressable
            onLongPress={openMenu}
            delayLongPress={350}
            className="border-border/60 bg-muted/40 rounded-lg border"
            style={{ maxWidth: '80%', paddingHorizontal: webSpace(4), paddingVertical: webSpace(2.5), gap: webSpace(1.5) }}
          >
            <View className="flex-row items-center" style={{ gap: webSpace(2) }}>
              <Icon
                as={channelMessageInfo.platform === 'Telegram' ? PaperPlaneTiltIcon : SlackLogoIcon}
                size={webSpace(3.5)}
                color={brand}
              />
              <Text variant="muted" style={[META_TEXT_STYLE, { fontFamily: 'Roobert-Medium', color: brand }]}>
                {channelMessageInfo.platform}
              </Text>
              <Text variant="muted" style={META_TEXT_STYLE}>
                ·
              </Text>
              <Text variant="small" className="leading-5">
                {channelMessageInfo.userName}
              </Text>
            </View>
            {channelMessageInfo.messageText ? (
              <Text className="text-sm">{channelMessageInfo.messageText}</Text>
            ) : null}
          </Pressable>
          </MessageMenu>
          {actions}
        </View>
      </Reanimated.View>
    );
  }

  if (triggerEventInfo) {
    return (
      <Reanimated.View className="px-4" style={dimStyle}>
        <View className="items-end" style={{ gap: webSpace(1) }}>
          <MessageMenu {...menuProps}>
          <Pressable
            onLongPress={openMenu}
            delayLongPress={350}
            className="border-border/60 bg-muted/40 rounded-lg border"
            style={{ maxWidth: '80%', paddingHorizontal: webSpace(4), paddingVertical: webSpace(2.5), gap: webSpace(1.5) }}
          >
            <View className="flex-row items-center" style={{ gap: webSpace(2) }}>
              <Icon as={TimerIcon} size={webSpace(3.5)} className="text-muted-foreground" />
              <Text className="text-sm" style={{ fontFamily: 'Roobert-Medium' }}>
                {triggerEventInfo.data?.trigger || 'Scheduled Task'}
              </Text>
              {triggerEventInfo.data?.data?.manual ? (
                <View className="bg-muted rounded-sm px-1.5">
                  <Text variant="muted" style={META_TEXT_STYLE}>
                    Manual
                  </Text>
                </View>
              ) : null}
            </View>
            {triggerEventInfo.prompt ? (
              <Text variant="muted" numberOfLines={3} style={[META_TEXT_STYLE, { paddingLeft: webSpace(5.5) }]}>
                {triggerEventInfo.prompt}
              </Text>
            ) : null}
          </Pressable>
          </MessageMenu>
          {actions}
        </View>
      </Reanimated.View>
    );
  }

  const failed = uploadStatus?.state === 'failed' ? uploadStatus : undefined;
  const hasBubble = Boolean(bodyText || content.quotes.length > 0 || commandInfo);

  return (
    <Reanimated.View className="px-4" style={dimStyle}>
      <View className="items-end self-end" style={{ maxWidth: '80%', gap: webSpace(2) }}>
        {attachments.length > 0 || failed ? (
          <MessageAttachments attachments={attachments} status={failed} onOpenPath={onFileMention} />
        ) : null}

        {hasBubble ? (
          // A failed send greys its bubble; "Try again" above stays full strength.
          <MessageMenu {...menuProps} onSelectText={() => setSelecting(true)}>
            <View className="items-end" style={failed ? FAILED_BUBBLE_STYLE : undefined}>
              <UserMessageBubble
                isDark={isDark}
                quotes={content.quotes}
                // While selecting, a long press belongs to the text selection.
                onLongPress={selecting ? undefined : openMenu}>
                {selecting ? (
                  <SelectableMessageText text={promptText} isDark={isDark} />
                ) : bodyText || commandInfo ? (
                  <MessageBody
                    text={bodyText}
                    command={commandInfo?.name}
                    sessions={content.sessions}
                    agentNames={agentNames}
                    onFileMention={onFileMention}
                    onSessionMention={onSessionMention}
                  />
                ) : null}
              </UserMessageBubble>
            </View>
          </MessageMenu>
        ) : null}

        {actions}
      </View>
    </Reanimated.View>
  );
}

// ─── Long-press menu ─────────────────────────────────────────────────────────

/**
 * The message menu, anchored under its bubble (`relativeTo="trigger"`, bottom,
 * end-aligned like the bubble): the time it was sent, then Copy · Select text
 * · Edit. The components are the RNR `context-menu`; `ContextMenuContent`
 * portals over the thread and closes on a tap outside or an item.
 */
function MessageMenu({
  menuRef,
  text,
  timestamp,
  edited,
  onEdit,
  onSelectText,
  children,
}: {
  menuRef: React.RefObject<TriggerRef | null>;
  text: string;
  timestamp: number | null;
  edited: boolean;
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
      {/* The trigger only measures the bubble: the bubble's own long press
          calls `menuRef.current.open()`. */}
      <ContextMenuTrigger ref={menuRef} asChild>
        <View>{children}</View>
      </ContextMenuTrigger>
      <ContextMenuContent side="bottom" align="end" sideOffset={6} className="min-w-48">
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
 * Select text: the message, selectable in its own bubble, in the bubble's type.
 * Android: a selectable `Text` is a TextView with range selection. iOS: a
 * selectable `Text` offers only "Copy" of the whole text, so a read-only raw
 * `TextInput` (not `Input`: it is not a field, and `Input` draws one) gives
 * range selection.
 */
function SelectableMessageText({ text, isDark }: { text: string; isDark: boolean }) {
  if (Platform.OS === 'ios') {
    return (
      <TextInput
        value={text}
        editable={false}
        multiline
        scrollEnabled={false}
        style={[BUBBLE_TEXT_STYLE, { color: paletteFor(isDark).foreground, padding: 0 }]}
      />
    );
  }
  return (
    <Text selectable style={BUBBLE_TEXT_STYLE}>
      {text}
    </Text>
  );
}

// ─── Body: text with mention chips ───────────────────────────────────────────

function MessageBody({
  text,
  command,
  sessions,
  agentNames,
  onFileMention,
  onSessionMention,
}: {
  text: string;
  command?: string;
  sessions: { id: string; title: string }[];
  agentNames?: string[];
  onFileMention?: (path: string) => void;
  onSessionMention?: (sessionId: string) => void;
}) {
  const segments = useMemo(
    () =>
      buildMentionSegments({
        text,
        sessionTitles: sessions.map((s) => s.title),
        agentNames,
      }),
    [text, sessions, agentNames],
  );

  let offset = 0;
  return (
    <Text style={BUBBLE_TEXT_STYLE}>
      {command ? (
        <>
          <MentionChip kind="command" label={command} />
          {text ? ' ' : null}
        </>
      ) : null}
      {segments.map((seg) => {
        const key = `${offset}-${seg.type ?? 'text'}`;
        offset += seg.text.length;
        const label = seg.text.replace(/^@/, '');
        if (seg.type === 'file') {
          return (
            <MentionChip
              key={key}
              kind="file"
              label={label}
              onPress={onFileMention ? () => onFileMention(label) : undefined}
            />
          );
        }
        if (seg.type === 'session') {
          const id = label.startsWith('ses_') ? label : sessions.find((s) => s.title === label)?.id;
          return (
            <MentionChip
              key={key}
              kind="session"
              label={label}
              onPress={onSessionMention && id ? () => onSessionMention(id) : undefined}
            />
          );
        }
        if (seg.type === 'agent') {
          return <MentionChip key={key} kind="agent" label={label} />;
        }
        return <Text key={key}>{seg.text}</Text>;
      })}
    </Text>
  );
}

// ─── Bubble ──────────────────────────────────────────────────────────────────

/**
 * `bg-sidebar dark:bg-muted px-3.5 py-2.5 rounded-lg`, hugging its text. Long
 * text clamps at 200px under a 36.8px fade in the bubble colour; the chevron
 * (and a tap anywhere on the bubble) expands it.
 */
export function UserMessageBubble({
  isDark,
  quotes = [],
  children,
  onLongPress,
}: {
  isDark: boolean;
  /** Quoted passages above the text. Omitted by the connecting screen's pending-prompt bubble. */
  quotes?: string[];
  children?: React.ReactNode;
  /** Opens the message menu (Copy · Select text · Edit). */
  onLongPress?: () => void;
}) {
  const palette = paletteFor(isDark);
  const surface = isDark ? palette.muted : palette.sidebar;
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const canExpand = contentHeight > CLAMP_HEIGHT + 2;
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withTiming(expanded ? 180 : 0, {
      duration: MOTION.duration.normal,
      easing: Easing.bezier(...MOTION.easing.default),
    });
  }, [expanded, rotation]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  const onContentLayout = useCallback((e: LayoutChangeEvent) => {
    setContentHeight(e.nativeEvent.layout.height);
  }, []);

  return (
    <Pressable
      onPress={canExpand ? toggle : undefined}
      onLongPress={onLongPress}
      delayLongPress={350}
      disabled={!canExpand && !onLongPress}
      accessible={false}
      style={{
        maxWidth: '100%',
        backgroundColor: surface,
        borderRadius: BUBBLE_RADIUS,
        paddingHorizontal: BUBBLE_PADDING_X,
        paddingVertical: BUBBLE_PADDING_Y,
        overflow: 'hidden',
      }}
    >
      {quotes.length > 0
        ? quotes.map((quote, i) => (
            <View
              key={i}
              className="border-border border-l-2"
              style={{
                paddingLeft: webSpace(2.5),
                marginBottom: quoteMarginBottom(i, quotes.length, Boolean(children)),
              }}
            >
              <Text variant="muted" numberOfLines={2} style={{ lineHeight: webSpace(5) }}>
                {quote}
              </Text>
            </View>
          ))
        : null}

      {children ? (
        <View>
          <View style={{ maxHeight: expanded ? undefined : CLAMP_HEIGHT, overflow: 'hidden' }}>
            <View onLayout={onContentLayout}>{children}</View>
          </View>

          {canExpand && !expanded ? (
            <LinearGradient
              pointerEvents="none"
              colors={[withAlpha(surface, 0), surface]}
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE_HEIGHT }}
            />
          ) : null}

          {canExpand ? (
            <Pressable
              onPress={toggle}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse message' : 'Expand message'}
              accessibilityState={{ expanded }}
              className="rounded-md"
              style={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                padding: webSpace(1),
                backgroundColor: withAlpha(palette.muted, 0.8),
              }}
            >
              <Reanimated.View style={chevronStyle}>
                <Icon as={CaretDownIcon} size={webSpace(3.5)} className="text-muted-foreground" />
              </Reanimated.View>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────────

/**
 * Replaces the column while a message is edited: the bubble surface at full
 * width (`w-full gap-2 py-3`), the text, then secondary Cancel + primary Send.
 * Send rewinds the session to this message and sends the edited text.
 *
 * A raw `TextInput`, not `Textarea`: the editor must focus with the caret at
 * the end, and `Textarea` is not `forwardRef` and draws a border.
 */
export function UserMessageEditor({
  isDark,
  initialText,
  pending,
  onCancel,
  onSend,
}: {
  isDark: boolean;
  initialText: string;
  pending?: boolean;
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const palette = paletteFor(isDark);
  const [draft, setDraft] = useState(initialText);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>({
    start: initialText.length,
    end: initialText.length,
  });
  const canSend = Boolean(draft.trim()) && !pending;

  return (
    <View
      style={{
        width: '100%',
        gap: webSpace(2),
        backgroundColor: isDark ? palette.muted : palette.sidebar,
        borderRadius: BUBBLE_RADIUS,
        paddingHorizontal: BUBBLE_PADDING_X,
        paddingVertical: webSpace(3),
      }}
    >
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        autoFocus
        editable={!pending}
        selection={selection}
        onSelectionChange={() => setSelection(undefined)}
        accessibilityLabel="Edit message"
        placeholderTextColor={palette.mutedForeground}
        style={{
          ...BUBBLE_TEXT_STYLE,
          color: palette.foreground,
          maxHeight: 280,
          padding: 0,
          textAlignVertical: 'top',
        }}
      />
      <View className="flex-row items-center justify-end" style={{ gap: webSpace(2) }}>
        <Button variant="secondary" size="sm" disabled={pending} onPress={onCancel}>
          <Text>Cancel</Text>
        </Button>
        <Button size="sm" disabled={!canSend} onPress={() => canSend && onSend(draft)}>
          {pending ? <KortixLoader customSize={14} /> : null}
          <Text>Send</Text>
        </Button>
      </View>
    </View>
  );
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/**
 * `flex flex-col items-end gap-1.5` over `flex flex-wrap justify-end gap-2`.
 * Past 8 attachments the last slot is a `+N` tile that expands the strip. A
 * failed send says "Not sent · Try again" (COR-143); the whole line retries.
 */
export function MessageAttachments({
  attachments,
  status,
  onOpenPath,
}: {
  attachments: MessageAttachment[];
  status?: UserMessageUploadStatus;
  onOpenPath?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { visible, overflowCount } = planAttachmentGrid(attachments, expanded);
  if (visible.length === 0 && !status) return null;

  return (
    <View className="items-end" style={{ gap: webSpace(1.5) }}>
      {visible.length > 0 ? (
        <View className="flex-row flex-wrap justify-end" style={{ gap: webSpace(2) }}>
          {visible.map((file) => (
            <MessageAttachmentTile key={file.key} file={file} onOpenPath={onOpenPath} />
          ))}
          {overflowCount > 0 ? (
            <AttachmentOverflowTile count={overflowCount} onPress={() => setExpanded(true)} />
          ) : null}
        </View>
      ) : null}
      {status ? (
        <View accessibilityRole="alert" className="items-end">
          {status.onRetry ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={status.onRetry}
              accessibilityLabel="Message not sent. Try again">
              <Text>Not sent · Try again</Text>
            </Button>
          ) : (
            <Text variant="muted" className="text-right" style={META_TEXT_STYLE}>
              Not sent
            </Text>
          )}
          {status.message ? (
            <Text variant="muted" className="text-right" style={META_TEXT_STYLE}>
              {status.message}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One sent attachment. An image in the sandbox loads through `useSandboxImage`
 * (HEAD probe, tap-to-load above the size limit); until it loads, or when it
 * fails, the tile is the named tile. Tapping opens the file in the file sheet.
 */
function MessageAttachmentTile({
  file,
  onOpenPath,
}: {
  file: MessageAttachment;
  onOpenPath?: (path: string) => void;
}) {
  const source = localOrResolvedSource(file.localUri, file.src);
  const path = source && 'path' in source ? source.path : '';
  const directUri = source && 'uri' in source ? source.uri : null;
  const isImage = isPreviewableImage(file.filename, file.mime);
  const image = useSandboxImage(path, isImage && !!path);
  const open = path && onOpenPath ? () => onOpenPath(path) : undefined;

  if (isImage && directUri) {
    return (
      <AttachmentTile filename={file.filename} mime={file.mime} imageSource={{ uri: directUri }} onPress={open} />
    );
  }
  if (isImage && path && image.phase === 'load' && image.source) {
    return (
      <AttachmentTile
        filename={file.filename}
        mime={file.mime}
        imageSource={image.source}
        imageKey={image.attempt}
        onImageError={image.handleError}
        onPress={open}
      />
    );
  }
  if (isImage && path && image.phase === 'tap-to-load') {
    const size = image.sizeBytes !== null ? formatMegabytes(image.sizeBytes) : null;
    return (
      <AttachmentTile
        filename={file.filename}
        mime={file.mime}
        onPress={image.loadAnyway}
        accessibilityLabel={size ? `Load ${file.filename}, ${size}` : `Load ${file.filename}`}
        corner={<Icon as={DownloadSimpleIcon} size={webSpace(4)} className="text-muted-foreground" />}
      />
    );
  }
  return <AttachmentTile filename={file.filename} mime={file.mime} onPress={open} />;
}
