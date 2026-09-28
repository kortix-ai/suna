import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { TriggerRef } from '@rn-primitives/context-menu';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { SandboxPreviewCard, detectLocalhostUrls } from '@/components/session/SandboxPreviewCard';
import { haptics } from '@/lib/haptics';
import { TYPE } from '@/lib/markdown/markdown-layout';
import { FONT_FAMILY } from '@/lib/utils/fonts';
import { MessageMenu, SelectableMessageText, SelectTextDoneButton } from './message-menu';

/** The markdown body's type (`selectable-markdown.tsx` `body`), for Select text. */
const ASSISTANT_TEXT_STYLE = {
  fontFamily: FONT_FAMILY.medium,
  fontSize: TYPE.body.fontSize,
  lineHeight: TYPE.body.lineHeight,
} as const;

/**
 * Assistant prose: markdown plus a preview card per localhost URL.
 *
 * Mirrors apps/web `session-chat.tsx` text rendering (`min-w-0 text-sm`,
 * `ThrottledMarkdown isStreaming` while the part can still grow,
 * `SandboxUrlDetector` once settled). Spacing belongs to the turn's stacks,
 * so the block carries no margin. Memoized on its props, so a delta on
 * another part of the turn does not rescan this text.
 *
 * Selection is the user message's (KRTX-607): a long press opens
 * `MessageMenu` (Copy · Select text); Select text shows the source text
 * selectable in place until Done. Links stay tappable because the rendered
 * markdown is never natively selectable (KRTX-562).
 */
export const TextPartBlock = React.memo(function TextPartBlock({
  text,
  isDark,
  isStreaming = false,
}: {
  text: string;
  isDark: boolean;
  /** The part can still grow: an unclosed code fence renders as growing. */
  isStreaming?: boolean;
}) {
  const detectedUrls = useMemo(() => detectLocalhostUrls(text), [text]);
  const menuRef = useRef<TriggerRef>(null);
  const [selecting, setSelecting] = useState(false);
  const openMenu = useCallback(() => {
    if (!text.trim()) return;
    haptics.medium();
    menuRef.current?.open();
  }, [text]);

  return (
    <View style={{ minWidth: 0 }}>
      <MessageMenu menuRef={menuRef} text={text} align="start" onSelectText={() => setSelecting(true)}>
        {/* Not `accessible`: an accessible wrapper would hide the links inside
            from a screen reader. While selecting, a long press belongs to the
            text selection. */}
        <Pressable accessible={false} onLongPress={selecting ? undefined : openMenu} delayLongPress={350}>
          {selecting ? (
            <SelectableMessageText text={text} isDark={isDark} style={ASSISTANT_TEXT_STYLE} />
          ) : (
            <SelectableMarkdownText isDark={isDark} isStreaming={isStreaming} selectOnDoubleTap={false}>
              {text}
            </SelectableMarkdownText>
          )}
        </Pressable>
      </MessageMenu>
      {selecting ? <SelectTextDoneButton className="self-start" onPress={() => setSelecting(false)} /> : null}
      {/* The row names itself: "App preview · localhost:3000". Passing the URL
          as the title and "Tap to open in browser" as the description said the
          same thing three times (Jay, 2026-09-22). */}
      {detectedUrls.map((detected) => (
        // 12pt (`pt-3`) off the message above it: the old bordered card carried
        // its own `my-2`, and the row has no margin of its own (Jay, 2026-09-22).
        <View key={`preview-${detected.port}`} className="pt-3">
          <SandboxPreviewCard port={detected.port} path={detected.path} />
        </View>
      ))}
    </View>
  );
});
