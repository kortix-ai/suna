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
 */

import React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
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
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const files = firstFiles ?? [];
  const hasFiles = files.length > 0;

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
          ) : (
            <KortixLoader size="medium" />
          )}
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
          {restarting ? (
            <ActivityIndicator size="small" color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
          ) : (
            <RotateCcw size={15} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
          )}
          <Text>{restarting ? 'Restarting…' : 'Restart session'}</Text>
        </Button>
      ) : null}
      <Button variant="ghost" onPress={onCancel} className="rounded-full">
        <Text>Back to project</Text>
      </Button>
    </View>
  );
}
