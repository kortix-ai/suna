/**
 * SessionConnecting — the session page while its sandbox starts.
 *
 * Loading looks like the thread it becomes (Jay, 2026-09-24): `ProjectScreen`
 * renders the thread header (floating menu button + the session title) beside
 * it, and this view draws the rest of the page — the user's first message
 * and its files where the thread shows them, one `KortixLoader` in the
 * centre, and the composer at the bottom, disabled until the thread replaces
 * this view. No step checklist, no timer, no Cancel bar.
 *
 * When the runtime fails to boot (a repo-materialization / git-clone failure
 * surfaced via /kortix/health `boot_error`, a terminal /start answer, or the
 * connect loop's own timeout), the failure is a card with the composer's
 * surface, the detail, Restart, and a way back to project home, centred in the
 * page, with no composer (Jay, 2026-10-02: nothing can be sent). Web parity with the dashboard's "OpenCode runtime is not ready"
 * screen (apps/web/.../sessions/[sessionId]/page.tsx InlineSessionError).
 *
 * With a SAVED COPY (`messages`: the copy this device kept, then the server's;
 * `lib/session/saved-copy.ts`) the view is the thread itself: its turns,
 * read-only, and a status card above the composer saying what the computer
 * is doing. The loader is gone — the conversation is the content. A failure takes
 * the composer's slot here too, so the thread stays readable, the rule the web
 * follows: a readable conversation is never replaced by a card.
 *
 * A conversation the saved copy proves EMPTY (`empty`) has nothing to wait
 * for: no loader, the status card and the composer.
 *
 * The composer is disabled until the thread replaces this view: no typing,
 * no keyboard (Jay, 2026-10-02). A waking composer that took text had no agent
 * chip, no attach, no keyboard avoidance, and a dead send button.
 */

import React from 'react';
import { ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { groupMessagesIntoTurns, type SessionMessageAuthors, type SessionParticipants } from '@kortix/sdk';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowCounterClockwiseIcon as RotateCcw } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { COMPOSER_CARD_CLASS, Composer } from '@/components/kortix/composer';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { FLOATING_MENU_CLEARANCE } from '@/components/session/FloatingMenuButton';
import { AttachmentTile } from '@/components/session/attachment-tile';
import { UserMessageBubble } from '@/components/session/turn/user-message';
import { SessionTurn } from '@/components/session/SessionTurn';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { ToolFilePreviewHost, useToolFilePreviewStore } from '@/components/session/tool/shared/navigation';
import type { MessageWithParts, Turn } from '@/lib/session/types';
import { turnTopGap } from '@/lib/session/auto-scroll';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { AttachedFile } from '@/lib/session/attachments';
import { isPreviewableImage } from '@/lib/session/attachment-tile';
import { webSpace } from '@/lib/session/user-message';
import { useSessionMessageAuthors, useSessionParticipants } from '@/lib/projects/hooks';
import { messageAvatarPerson } from '@/lib/session/participants';

export interface SessionConnectError {
  title: string;
  message: string;
  /** Raw runtime failure detail (e.g. the git clone error). Shown verbatim. */
  detail?: string;
}

/** `text-[0.9rem] leading-[22px] font-medium` — same as the thread's user bubble (turn/user-message.tsx). */
const BUBBLE_TEXT_STYLE = { fontFamily: 'Roobert-Medium', fontSize: 14.4, lineHeight: 22 } as const;
const noop = () => {};

export function SessionConnecting({
  firstMessage,
  firstFiles,
  error,
  onCancel,
  onRestart,
  restarting,
  showLoader = true,
  messages,
  statusLabel,
  sessionId,
  empty = false,
  projectId,
  projectSessionId,
}: {
  /** The user's just-sent first message (a fresh send from project home), shown as the thread shows it. */
  firstMessage?: string;
  /** The files sent with that first message, drawn as the thread draws them: tiles above the bubble. */
  firstFiles?: AttachedFile[];
  /** When set, the centre shows the failure instead of the loader. */
  error?: SessionConnectError | null;
  /** Leaves the failed start and returns to project home. */
  onCancel: () => void;
  onRestart?: () => void;
  restarting?: boolean;
  /**
   * Draw the centre loader. False while the project drawer covers this view:
   * the drawer owns the one loader then (KRTX-244).
   */
  showLoader?: boolean;
  /** The session's saved copy, shown as the thread while the computer wakes. */
  messages?: MessageWithParts[];
  /** What the computer is doing, for the status card above the composer (`sessionConnectionLabel`). */
  statusLabel?: string | null;
  /** The runtime session the saved copy belongs to; tool rows read it. */
  sessionId?: string;
  /** The saved copy proves the conversation empty: nothing to wait for. */
  empty?: boolean;
  /**
   * The project session, for the shared-session senders. Read here, not only
   * in `SessionPage`: the saved copy shows while the computer wakes, and its
   * prompts carry their avatars from the first frame. The live page reuses
   * the cached answer.
   */
  projectId?: string;
  projectSessionId?: string;
}) {
  const { colorScheme } = useColorScheme();
  const participants = useSessionParticipants(projectId, projectSessionId).data;
  const messageAuthors = useSessionMessageAuthors(projectId, projectSessionId).data;
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const files = firstFiles ?? [];
  const hasFiles = files.length > 0;
  const turns = React.useMemo(
    () => (messages && messages.length > 0 ? (groupMessagesIntoTurns(messages) as unknown as Turn[]) : []),
    [messages],
  );

  if (turns.length > 0) {
    return (
      <SavedThread
        turns={turns}
        sessionId={sessionId}
        statusLabel={statusLabel ?? null}
        error={error}
        onCancel={onCancel}
        onRestart={onRestart}
        restarting={restarting}
        participants={participants}
        messageAuthors={messageAuthors}
      />
    );
  }

  if (empty && !error && !hasFiles && !firstMessage) {
    return (
      <View style={{ flex: 1 }} className="bg-background">
        <View style={{ flex: 1 }} />
        <WakingDock label={statusLabel} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }} className="bg-background">
      {/* The thread's list area: the first message under the header, the
          loader (or the failure) centred in what is left. */}
      <View style={{ flex: 1, paddingTop: insets.top + FLOATING_MENU_CLEARANCE }} className="px-4">
        {/* The thread's user message (`turn/user-message.tsx`): one
            right-aligned column capped at 80%, files above the bubble. */}
        {hasFiles || firstMessage ? (
          <View className="items-end self-end" style={{ maxWidth: '80%', gap: webSpace(2) }}>
            {hasFiles ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                className="flex-grow-0"
                contentContainerStyle={{ gap: webSpace(2) }}>
                {files.map((file, index) => (
                  <AttachmentTile
                    key={`${file.uri}-${index}`}
                    filename={file.name}
                    mime={file.mimeType}
                    imageSource={
                      file.isImage && isPreviewableImage(file.name, file.mimeType) ? { uri: file.uri } : undefined
                    }
                  />
                ))}
              </ScrollView>
            ) : null}
            {firstMessage ? (
              <UserMessageBubble isDark={isDark}>
                <Text style={BUBBLE_TEXT_STYLE}>{firstMessage}</Text>
              </UserMessageBubble>
            ) : null}
          </View>
        ) : null}
        {/* No conversation above: the failure sits where the eye already is,
            the centre, not down in the composer's slot (Jay, 2026-10-02). */}
        <View style={{ flex: 1 }} className="justify-center">
          {error ? (
            <ConnectErrorState error={error} onCancel={onCancel} onRestart={onRestart} restarting={restarting} sessionId={sessionId} />
          ) : showLoader ? (
            <View className="items-center">
              <KortixLoader size="medium" />
            </View>
          ) : null}
        </View>
      </View>

      {/* The thread's composer, where `SessionPage` puts it (`WakingDock`).
          Disabled: there is no runtime to send to yet. None under a failure:
          nothing can be sent. */}
      {error ? <View style={{ height: insets.bottom }} /> : <WakingDock />}
    </View>
  );
}

/** The composer while the computer wakes: disabled, there is no runtime to send to yet. */
function WakingComposer() {
  return <Composer value="" onChangeText={noop} onSubmit={noop} disabled onAttach={noop} />;
}

/**
 * The waking dock: the safe-area pad, the status card (`label`) saying what
 * the computer is doing, and the thread's composer slot where `SessionPage`
 * puts its composer over the safe area. Every waking branch ends in one; the
 * composer is disabled — there is no runtime to send to yet. A child replaces
 * the composer when the slot holds something else (a boot failure).
 */
function WakingDock({
  label,
  children = <WakingComposer />,
}: {
  /** What the computer is doing, for the status card above the composer. */
  label?: string | null;
  children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingBottom: insets.bottom }}>
      {label ? <WakingStatus label={label} /> : null}
      <View className="px-4 pb-3 pt-1">{children}</View>
    </View>
  );
}

/**
 * What the computer is doing: a card above the composer with the composer
 * card's own surface (`COMPOSER_CARD_CLASS`), so the two read as a pair. The
 * dot sits on the first line of text, the words on the composer's text inset.
 */
function WakingStatus({ label }: { label: string }) {
  return (
    <View className="px-4 pb-2" accessibilityLiveRegion="polite">
      <View className={COMPOSER_CARD_CLASS}>
        <View className="flex-row items-start gap-2.5 px-2 py-1">
          {/* One text line tall (leading-5), so the dot centres on the first line. */}
          <View className="h-5 justify-center">
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: THEME.accent.yellow }} />
          </View>
          <Text variant="muted" className="flex-1 leading-5" numberOfLines={2}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * The thread as its saved copy shows it: the turns, read-only, opened at the
 * newest message like the live thread; then the status card and the composer.
 * A failure takes the composer's slot and the thread stays readable.
 */
function SavedThread({
  turns,
  sessionId,
  statusLabel,
  error,
  onCancel,
  onRestart,
  restarting,
  participants,
  messageAuthors,
}: {
  turns: Turn[];
  participants?: SessionParticipants;
  messageAuthors?: SessionMessageAuthors;
  sessionId?: string;
  statusLabel: string | null;
  error?: SessionConnectError | null;
  onCancel: () => void;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const scrollRef = React.useRef<ScrollView>(null);
  const { colorScheme } = useColorScheme();
  const background = THEME[colorScheme === 'dark' ? 'dark' : 'light'].background;
  // Laid out exactly as `SessionPage`'s list: no list-level side padding (each
  // turn pads itself, `px-4` in `SessionTurn`), web's `mt-12` between turns
  // (`turnTopGap`), and attachment tiles / file mentions opening the Recent
  // files sheet (`ToolFilePreviewHost`).
  return (
    <View style={{ flex: 1 }} className="bg-background">
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + FLOATING_MENU_CLEARANCE, paddingBottom: 12 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
        {turns.map((turn, index) => {
          const gap = turnTopGap({ index, working: false, pending: false, previousPending: false });
          return (
            <View key={turn.userMessage.info.id} style={gap > 0 ? { marginTop: gap } : undefined}>
              <SessionTurn
                turn={turn}
                isWorkingTurn={false}
                isBusy={false}
                sessionId={sessionId}
                onFileMention={openFilePreview}
                rewindDisabled
                sender={messageAvatarPerson(
                  messageAuthors,
                  participants,
                  participants?.participants.find((person) => person.is_viewer)?.user_id,
                  turn.userMessage.info.id,
                )}
              />
            </View>
          );
        })}
      </ScrollView>

      {/* The thread's fade above the input (`SessionPage`). */}
      <LinearGradient
        colors={[withAlpha(background, 0), withAlpha(background, 1)]}
        style={{ height: 24, marginTop: -24, zIndex: 1 }}
        pointerEvents="none"
      />

      {error ? (
        <WakingDock>
          <ConnectErrorState error={error} onCancel={onCancel} onRestart={onRestart} restarting={restarting} sessionId={sessionId} />
        </WakingDock>
      ) : (
        <WakingDock label={statusLabel} />
      )}

      <ToolFilePreviewHost />
    </View>
  );
}

function openFilePreview(path: string) {
  useToolFilePreviewStore.getState().openPreview(path);
}

/**
 * The failure: the composer card's surface, the words on top, and Back to
 * project · Restart side by side, 50/50, the primary on the right. Centred in
 * the page when there is no conversation; in the composer's slot under a
 * saved copy.
 */
function ConnectErrorState({
  error,
  onCancel,
  onRestart,
  restarting,
  sessionId,
}: {
  error: SessionConnectError;
  onCancel: () => void;
  onRestart?: () => void;
  restarting?: boolean;
  /** Picks the restart glyph: the same dot matrix this session shows while it works. */
  sessionId?: string;
}) {
  const { colorScheme } = useColorScheme();
  // The glyph draws on the `default` pill: its foreground, not the muted dots.
  const onPrimary = THEME[colorScheme === 'dark' ? 'dark' : 'light'].primaryForeground;
  return (
    <View className={COMPOSER_CARD_CLASS} style={{ gap: 12 }}>
      <View className="gap-1 px-2 pt-1">
        <Text className="text-[15px] font-roobert-medium text-foreground">{error.title}</Text>
        <Text className="text-[13px] leading-5 text-muted-foreground">{error.message}</Text>
      </View>
      {error.detail ? (
        <View className="w-full rounded-2xl border border-border bg-muted/40 px-3 py-2">
          <Text className="font-mono text-[12px] leading-5 text-muted-foreground">{error.detail}</Text>
        </View>
      ) : null}
      <View className="flex-row gap-2">
        <Button variant="secondary" onPress={onCancel} className="flex-1 rounded-full">
          <Text>Back to project</Text>
        </Button>
        {onRestart ? (
          <Button variant="default" onPress={onRestart} disabled={restarting} className="flex-1 rounded-full">
            {/* Restarting: the session's dot matrix in place of the icon, inside
                the disabled pill, never a second loader (Jay, 2026-10-02). */}
            {restarting ? (
              <SessionDotMatrix sessionId={sessionId} size={14} color={onPrimary} />
            ) : (
              <Icon as={RotateCcw} size={15} />
            )}
            <Text>{restarting ? 'Restarting…' : 'Restart session'}</Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
