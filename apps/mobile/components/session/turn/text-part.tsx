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
      {detectedUrls.map((detected) => (
        <SandboxPreviewCard
          key={`preview-${detected.port}`}
          port={detected.port}
          path={detected.path}
          title={`localhost:${detected.port}${detected.path}`}
          description="Tap to open in browser"
        />
      ))}
    </View>
  );
});
