import React, { useMemo } from 'react';
import { View } from 'react-native';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { SandboxPreviewCard, detectLocalhostUrls } from '@/components/session/SandboxPreviewCard';

/**
 * Assistant prose: markdown plus a preview card per localhost URL.
 *
 * Mirrors apps/web `session-chat.tsx` text rendering (`min-w-0 text-sm`,
 * `ThrottledMarkdown isStreaming` while the part can still grow,
 * `SandboxUrlDetector` once settled). Spacing belongs to the turn's stacks,
 * so the block carries no margin. Memoized on its props, so a delta on
 * another part of the turn does not rescan this text.
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
  return (
    <View style={{ minWidth: 0 }}>
      <SelectableMarkdownText isDark={isDark} isStreaming={isStreaming}>
        {text}
      </SelectableMarkdownText>
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
