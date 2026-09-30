import React, { useMemo } from 'react';
import { View } from 'react-native';
import { detectLocalhostUrls } from '@kortix/sdk';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { SandboxPreviewCard } from '@/components/session/SandboxPreviewCard';
import { assistantSegments } from '@/lib/markdown/setup-links';
import { SetupLinkCard } from './setup-link-card';

/**
 * Assistant prose: markdown plus a preview card per localhost URL.
 *
 * A setup link the agent wrote (`/connect/<token>`, `/secret-intake/<token>`)
 * renders as a `SetupLinkCard` where the link stood, never as a raw URL: the
 * text is cut around it (`assistantSegments`). While the part streams, the
 * link still arriving is already its card, with the button waiting. A bare URL
 * in the prose becomes a tappable link, as on web.
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
  const segments = useMemo(() => assistantSegments(text, isStreaming), [text, isStreaming]);
  return (
    <View style={{ minWidth: 0 }}>
      {segments.map((segment, index) => {
        const previous = segments[index - 1];
        // Position is the identity: streaming only appends, so a pending card
        // and the finished card are one component.
        return (
          <View
            key={index}
            style={previous ? { marginTop: previous.type === 'setup' && segment.type === 'setup' ? 8 : 12 } : undefined}>
            {segment.type === 'setup' ? (
              <SetupLinkCard kind={segment.kind} token={segment.token} href={segment.href} label={segment.label} />
            ) : (
              <SelectableMarkdownText isDark={isDark} isStreaming={isStreaming}>
                {segment.text}
              </SelectableMarkdownText>
            )}
          </View>
        );
      })}
      {/* The row names itself: "App preview · localhost:3000". Passing the URL
          as the title and "Tap to open in browser" as the description said the
          same thing three times (Jay, 2026-09-22). */}
      {detectedUrls.map((detected) => (
        // 12pt (`pt-3`) off the message above it: the old bordered card carried
        // its own `my-2`, and the row has no margin of its own (Jay, 2026-09-22).
        // Keyed by URL: two cards can share a port under the SDK's URL-level dedupe.
        <View key={`preview-${detected.originalUrl}`} className="pt-3">
          <SandboxPreviewCard port={detected.port} path={detected.path} />
        </View>
      ))}
    </View>
  );
});
