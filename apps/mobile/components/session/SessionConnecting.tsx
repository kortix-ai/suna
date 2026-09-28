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
 * surfaced via /kortix/health `boot_error`, or the connect loop's own timeout),
 * the centre shows the failure with the detail, Restart, and a way back to
 * project home — web parity with the dashboard's "OpenCode runtime is not
 * ready" screen (apps/web/.../sessions/[sessionId]/page.tsx InlineSessionError).
 *
 * With a SAVED COPY (`messages`: the copy this device kept, then the server's;
 * `lib/session/saved-copy.ts`) the view is the thread itself: its turns,
 * read-only, and a status bar above the composer saying what the computer is
 * doing. The loader is gone — the conversation is the content. A failure then
 * takes the composer's slot instead of replacing the thread, the rule the web
 * follows: a readable conversation is never replaced by a card.
 */

import React from 'react';
import { ScrollView, View } from 'react-native';
import { groupMessagesIntoTurns } from '@kortix/sdk';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowCounterClockwiseIcon as RotateCcw } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/kortix/composer';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { FLOATING_MENU_CLEARANCE } from '@/components/session/FloatingMenuButton';
import { AttachmentTile } from '@/components/session/attachment-tile';
import { UserMessageBubble } from '@/components/session/turn/user-message';
import { SessionTurn } from '@/components/session/SessionTurn';
import type { MessageWithParts, Turn } from '@/lib/opencode/types';
import { THEME } from '@/lib/utils/theme';
import type { AttachedFile } from '@/lib/session/attachments';
import { isPreviewableImage } from '@/lib/session/attachment-tile';
import { webSpace } from '@/lib/session/user-message';

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
  /** What the computer is doing, for the status bar over the thread (`sessionConnectionLabel`). */
  statusLabel?: string | null;
  /** The OpenCode session the saved copy belongs to; tool rows read it. */
  sessionId?: string;
}) {
  const { colorScheme } = useColorScheme();
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
      />
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
        <View style={{ flex: 1 }} className="items-center justify-center">
          {error ? (
            <ConnectErrorState error={error} onCancel={onCancel} onRestart={onRestart} restarting={restarting} />
          ) : showLoader ? (
            <KortixLoader size="medium" />
          ) : null}
        </View>
      </View>

      {/* The thread's composer, where `SessionPage` puts it (`px-4 pb-3 pt-1`
          above the safe area). Disabled: there is no runtime to send to yet. */}
      <View style={{ paddingBottom: insets.bottom }}>
        <View className="px-4 pb-3 pt-1">
          <Composer value="" onChangeText={noop} onSubmit={noop} disabled onAttach={noop} />
        </View>
      </View>
    </View>
  );
}

/**
 * The thread as its saved copy shows it: the turns, read-only, opened at the
 * newest message like the live thread; then the status bar (the composer card,
 * as `SandboxHealthPill` draws it) and the disabled composer. A failure takes
 * the composer's slot and the thread stays readable.
 */
function SavedThread({
  turns,
  sessionId,
  statusLabel,
  error,
  onCancel,
  onRestart,
  restarting,
}: {
  turns: Turn[];
  sessionId?: string;
  statusLabel: string | null;
  error?: SessionConnectError | null;
  onCancel: () => void;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const scrollRef = React.useRef<ScrollView>(null);
  return (
    <View style={{ flex: 1 }} className="bg-background">
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + FLOATING_MENU_CLEARANCE, paddingBottom: 12 }}
        className="px-4"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
        {turns.map((turn) => (
          <SessionTurn
            key={turn.userMessage.info.id}
            turn={turn}
            isWorkingTurn={false}
            isBusy={false}
            sessionId={sessionId}
            rewindDisabled
          />
        ))}
      </ScrollView>

      <View style={{ paddingBottom: insets.bottom }}>
        {error ? (
          <View className="items-center px-4 pb-3 pt-1">
            <ConnectErrorState error={error} onCancel={onCancel} onRestart={onRestart} restarting={restarting} />
          </View>
        ) : (
          <>
            {statusLabel ? (
              <View className="px-4 pb-2" accessibilityLiveRegion="polite">
                <View className="flex-row items-center gap-2 rounded-3xl border border-border bg-background p-2">
                  <View className="flex-1 flex-row items-center gap-2 px-2 py-2">
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: THEME.accent.yellow }} />
                    <Text variant="muted" className="shrink" numberOfLines={1}>
                      {statusLabel}
                    </Text>
                  </View>
                </View>
              </View>
            ) : null}
            <View className="px-4 pb-3 pt-1">
              <Composer value="" onChangeText={noop} onSubmit={noop} disabled onAttach={noop} />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function ConnectErrorState({
  error,
  onCancel,
  onRestart,
  restarting,
}: {
  error: SessionConnectError;
  onCancel: () => void;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View className="w-full max-w-md items-center" style={{ gap: 12 }}>
      <Text className="text-[15px] font-roobert-medium text-foreground text-center">{error.title}</Text>
      <Text className="text-[13px] leading-5 text-muted-foreground text-center">{error.message}</Text>
      {error.detail ? (
        <View className="w-full rounded-2xl border border-border bg-muted/40 px-3 py-2">
          <Text className="font-mono text-[12px] leading-5 text-muted-foreground">{error.detail}</Text>
        </View>
      ) : null}
      {onRestart ? (
        <Button variant="outline" onPress={onRestart} disabled={restarting} className="mt-1 rounded-full">
          {/* Restarting is an inline disabled state, not a second loader. */}
          <RotateCcw size={15} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
          <Text>{restarting ? 'Restarting…' : 'Restart session'}</Text>
        </Button>
      ) : null}
      <Button variant="ghost" onPress={onCancel} className="rounded-full">
        <Text>Back to project</Text>
      </Button>
    </View>
  );
}
