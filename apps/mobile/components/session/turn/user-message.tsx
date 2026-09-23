/**
 * UserMessage — the user side of a turn. Mirrors apps/web
 * `features/session/turn/user-message.tsx` (`UserMessage`, `UserMessageBubble`,
 * `UserMessageActions`, `UserMessageEditor`, `MessageAttachments`).
 *
 * One right-aligned column capped at 80%: attachments → bubble → actions.
 * Pixel values are web's RENDERED values (web spacing is 0.23rem per step, see
 * `webSpace` in `lib/session/user-message.ts`). Pure logic lives in
 * `lib/session/user-message.ts`, `lib/session/mention-segments.ts` and
 * `lib/session/attachment-tile.ts`.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, TextInput, View, type LayoutChangeEvent } from 'react-native';
import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TURN_ACTION_HIT_SLOP } from '@/components/session/turn/session-turn-meta';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import {
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PencilSimpleRegularIcon,
  SlackLogoIcon,
  TimerIcon,
} from '@/lib/icons';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';
import type { Turn, TextPart } from '@/lib/opencode/types';
import type { Command } from '@/lib/opencode/hooks/use-opencode-data';
import { isTextPart, messageCreatedAt, splitUserParts, type MessageWithParts } from '@kortix/sdk';
import { detectCommandFromText } from '@/lib/session/detect-command';
import { formatMegabytes } from '@/lib/session/image-load';
import { buildMentionSegments } from '@/lib/session/mention-segments';
import {
  isPreviewableImage,
  planAttachmentGrid,
  resolveAttachmentSource,
} from '@/lib/session/attachment-tile';
import {
  commandMessageText,
  isUserMessageEdited,
  parseUserMessageText,
  queuedPromptStatusLabel,
  quoteMarginBottom,
  userMessageMetaItems,
  webSpace,
  type QueuedPromptState,
} from '@/lib/session/user-message';
import { MentionChip } from '../mention-chip';
import { AttachmentOverflowTile, AttachmentTile } from '../attachment-tile';
import { useSandboxImage } from './use-sandbox-image';

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

// ─── One clock for every relative time label ─────────────────────────────────

const TICK_MS = 30_000;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = 0;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, TICK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClockNow(): number {
  if (clockNow === 0) clockNow = Date.now();
  return clockNow;
}

function useNow(): number {
  return useSyncExternalStore(subscribeClock, getClockNow, getClockNow);
}

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
        const fp = p as unknown as { id: string; filename?: string; mime: string; url?: string };
        return { key: fp.id, filename: fp.filename || 'File', mime: fp.mime, src: fp.url };
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

  const channelMessageInfo = useMemo(() => {
    if (!rawText) return undefined;
    const headerMatch = rawText.match(/^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/);
    if (!headerMatch) return undefined;
    const platform = headerMatch[1] as 'Telegram' | 'Slack';
    const userName = headerMatch[3]!.trim();
    const afterHeader = rawText.slice(headerMatch[0].length);
    const instrStart = afterHeader.search(/\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/);
    const messageText = instrStart >= 0 ? afterHeader.slice(0, instrStart).trim() : afterHeader.trim();
    return { platform, userName, messageText };
  }, [rawText]);

  const triggerEventInfo = useMemo(() => {
    if (!rawText) return undefined;
    const match = rawText.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
    if (!match) return undefined;
    try {
      const data = JSON.parse(match[1]!);
      const prompt = rawText.replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '').trim();
      return { data, prompt };
    } catch {
      return undefined;
    }
  }, [rawText]);

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

  const actions = (
    <UserMessageActions
      isDark={isDark}
      timestamp={timestamp}
      edited={edited}
      copyText={promptText || undefined}
      onEdit={
        onEditStart && !rewindDisabled && !channelMessageInfo && !triggerEventInfo
          ? () => onEditStart(messageId, promptText)
          : undefined
      }
      leadingStatus={statusLabel}
    />
  );

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
          <View
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
          </View>
          {actions}
        </View>
      </Reanimated.View>
    );
  }

  if (triggerEventInfo) {
    return (
      <Reanimated.View className="px-4" style={dimStyle}>
        <View className="items-end" style={{ gap: webSpace(1) }}>
          <View
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
          </View>
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
          <View className="items-end" style={failed ? FAILED_BUBBLE_STYLE : undefined}>
            <UserMessageBubble isDark={isDark} quotes={content.quotes}>
              {bodyText || commandInfo ? (
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
        ) : null}

        {actions}
      </View>
    </Reanimated.View>
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
  quotes,
  children,
}: {
  isDark: boolean;
  quotes: string[];
  children?: React.ReactNode;
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
      disabled={!canExpand}
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

// ─── Actions row ─────────────────────────────────────────────────────────────

/**
 * `flex justify-end gap-2`: status, `InlineMeta` (relative time · edited at
 * `text-xs text-muted-foreground/70`, `·` at `/30`), Edit, Copy. Web reveals
 * the row on hover above 768px and shows it always below; a phone always shows it.
 */
export function UserMessageActions({
  isDark,
  timestamp,
  edited,
  copyText,
  onEdit,
  leadingStatus,
}: {
  isDark: boolean;
  timestamp: number | null;
  edited: boolean;
  copyText?: string;
  onEdit?: () => void;
  leadingStatus?: string | null;
}) {
  const palette = paletteFor(isDark);
  const now = useNow();
  const [copied, setCopied] = useState(false);
  const items = userMessageMetaItems({ timestamp, edited, now });
  const metaColor = withAlpha(palette.mutedForeground, 0.7);
  const separatorColor = withAlpha(palette.mutedForeground, 0.3);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    if (!copyText) return;
    await Clipboard.setStringAsync(copyText);
    setCopied(true);
  }, [copyText]);

  if (!leadingStatus && items.length === 0 && !copyText) return null;

  return (
    // 28pt `icon-sm` buttons, pulled back to web's 24px row height.
    <View className="-my-0.5 flex-row items-center justify-end" style={{ gap: webSpace(2) }}>
      {leadingStatus ? (
        <Text variant="muted" numberOfLines={1} className="shrink" style={[META_TEXT_STYLE, { color: metaColor }]}>
          {leadingStatus}
        </Text>
      ) : null}
      {items.length > 0 ? (
        <View className="shrink flex-row items-center" style={{ gap: webSpace(2) }}>
          {items.map((item, i) => (
            <View key={`${i}-${item}`} className="shrink flex-row items-center" style={{ gap: webSpace(2) }}>
              {i > 0 ? (
                <Text variant="muted" style={[META_TEXT_STYLE, { color: separatorColor }]}>
                  ·
                </Text>
              ) : null}
              <Text variant="muted" numberOfLines={1} style={[META_TEXT_STYLE, { color: metaColor, fontVariant: ['tabular-nums'] }]}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {copyText ? (
        <View className="flex-row items-center">
          {onEdit ? (
            <Button
              variant="ghost"
              size="icon-sm"
              hitSlop={TURN_ACTION_HIT_SLOP}
              onPress={onEdit}
              accessibilityLabel="Edit message">
              <Icon as={PencilSimpleRegularIcon} size={webSpace(4)} className="text-foreground" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            hitSlop={TURN_ACTION_HIT_SLOP}
            onPress={handleCopy}
            accessibilityLabel={copied ? 'Copied' : 'Copy message'}>
            <Icon as={copied ? CheckIcon : CopyIcon} size={webSpace(4)} className="text-foreground" />
          </Button>
        </View>
      ) : null}
    </View>
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
  const source = resolveAttachmentSource(file.src);
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
