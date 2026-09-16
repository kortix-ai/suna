/**
 * The previous mobile `show` renderers: `ShowExpandedContent` (the body
 * `tool-part-renderer.tsx`'s legacy switch hosts), `ShowToolCard`,
 * `SandboxImage`, `isImagePath`. `show-tool.tsx` re-exports them until the
 * legacy switch is removed; the registered `show` renderer is `ShowTool`.
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react';
import { View, ScrollView, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import ReAnimated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  FadeIn,
} from 'react-native-reanimated';
import {
  FileCodeIcon as FileCode2,
  GlobeIcon as Globe,
  ImageIcon,
  CaretDownIcon as ChevronDown,
  WarningCircleIcon as CircleAlert,
  ArrowSquareOutIcon as ExternalLink,
  FileTextIcon as FileText,
  FileTextIcon,
} from '@/lib/icons';
import * as Haptics from 'expo-haptics';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { FileViewer } from '@/components/files/FileViewer';
import type { SandboxFile } from '@/api/types';
import { useTabStore } from '@/stores/tab-store';
import type { ToolPart } from '@/lib/opencode/types';
import { useSandboxImage } from '@/components/session/turn/use-sandbox-image';
import { TapToLoadImage } from '@/components/session/turn/tap-to-load-image';
import { ShimmerStatusText } from '@/components/session/turn/shimmer-status-text';
import { cardBg, fg, monoFont, muted, mutedStrong } from '../shared/styles';
import { getToolInput, isToolAnimating } from '../shared/tool-part';
import { MonoBlock } from '../shared/output-block';
import { HighlightedCode } from '../shared/highlighted-code';

// ─── Image extension detection ──────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath);
}

// ─── SandboxImage — loads an image from the sandbox with auth ────────────────

export function SandboxImage({
  filePath,
  isDark,
  height = 240,
}: {
  filePath: string;
  isDark: boolean;
  height?: number;
}) {
  const { phase, source, sizeBytes, attempt, loadAnyway, handleError } = useSandboxImage(filePath, true);
  const placeholderBg = isDark ? withAlpha(THEME.dark.foreground, 0.03) : withAlpha(THEME.light.foreground, 0.02);

  // No sandbox yet: keep the loading placeholder until the URL resolves.
  if (phase === 'probing' || !source) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center', backgroundColor: placeholderBg }}>
        <KortixLoader customSize={20} />
      </View>
    );
  }

  if (phase === 'tap-to-load') {
    return <TapToLoadImage sizeBytes={sizeBytes} height={height} isDark={isDark} onLoad={loadAnyway} />;
  }

  if (phase === 'error') {
    return (
      <View style={{ height: 60, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 12, color: muted(isDark) }}>
          Failed to load image
        </Text>
      </View>
    );
  }

  return (
    <Image
      key={attempt}
      source={source}
      onError={handleError}
      style={{ width: '100%', height, borderBottomLeftRadius: 13, borderBottomRightRadius: 13, backgroundColor: placeholderBg }}
      resizeMode="cover"
      resizeMethod="resize"
    />
  );
}

export function ShowExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const title = input.title || input.description || '';
  const filePath = input.path || '';
  const content = input.content || '';

  // Parse output (always, to avoid conditional hook)
  const parsedOutput = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      const raw = tool.state.output.trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.entry?.path || parsed.path) {
          const p = parsed.entry?.path || parsed.path;
          const t = parsed.entry?.title || parsed.title || title;
          return { type: 'file' as const, path: p, title: t };
        }
        if (parsed.message) {
          return { type: 'message' as const, text: parsed.message };
        }
      } catch {}
      return { type: 'raw' as const, text: raw };
    }
    return undefined;
  }, [tool.state, title]);

  // Show image directly if the input path is an image
  if (filePath && isImagePath(filePath) && !content) {
    return <SandboxImage filePath={filePath} isDark={isDark} height={240} />;
  }

  // Show file content with syntax highlighting if available
  if (content) {
    return (
      <ScrollView
        style={{ maxHeight: 300 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <HighlightedCode
          content={content.length > 4000 ? content.slice(0, 4000) : content}
          filePath={filePath || 'file.md'}
          isDark={isDark}
          maxLines={50}
        />
      </ScrollView>
    );
  }

  if (!parsedOutput) return null;

  if (parsedOutput.type === 'file') {
    // If the output file is an image, render it inline
    if (isImagePath(parsedOutput.path)) {
      return <SandboxImage filePath={parsedOutput.path} isDark={isDark} height={240} />;
    }
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <FileTextIcon size={14} color={muted(isDark)} style={{ marginRight: 6 }} />
          <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: mutedStrong(isDark), flex: 1 }}>
            {parsedOutput.path}
          </Text>
        </View>
        {parsedOutput.title && (
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
            {parsedOutput.title}
          </Text>
        )}
      </View>
    );
  }

  if (parsedOutput.type === 'message') {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 18 }}>
          {parsedOutput.text}
        </Text>
      </View>
    );
  }

  // Raw fallback
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 200 }}>
      <MonoBlock isDark={isDark} maxLines={15}>
        {parsedOutput.text.length > 1000 ? parsedOutput.text.slice(0, 1000) + '\n...' : parsedOutput.text}
      </MonoBlock>
    </View>
  );
}

// ─── ShowToolCard — rich interactive card for "show" / "show-user" tool ──────

const LOCALHOST_RE = /https?:\/\/localhost:(\d+)(\/[^\s)]*)?/;

export const ShowToolCard = React.memo(function ShowToolCard({
  tool,
  isDark,
  working,
}: {
  tool: ToolPart;
  isDark: boolean;
  working: boolean;
}) {
  const input = getToolInput(tool);
  const { sandboxId, sandboxUrl: ctxSandboxUrl } = useSandboxContext();

  const title = (input.title as string) || '';
  const description = (input.description as string) || '';
  const type = (input.type as string) || '';
  const url = (input.url as string) || '';
  const path = (input.path as string) || '';
  const content = (input.content as string) || '';
  const isRunning = isToolAnimating(tool, working);
  const isError = tool.state.status === 'error';

  // Determine if we have a localhost URL to open in browser
  const localhostMatch = url ? url.match(LOCALHOST_RE) : null;
  const hasLocalhostUrl = !!localhostMatch;
  const canOpen = !!(url || path || hasLocalhostUrl);
  const isHtmlFile = !!path && /\.(html?|htm)$/i.test(path);

  // Determine display title
  const displayTitle = title || (type === 'error' ? 'Error' : type === 'url' ? 'Link' : 'Output');

  // Determine icon
  const IconComponent = (() => {
    switch (type) {
      case 'image': return ImageIcon;
      case 'code': return FileCode2;
      case 'markdown': return FileText;
      case 'html': return Globe;
      case 'url': return Globe;
      case 'error': return CircleAlert;
      case 'file': return FileText;
      default: return ExternalLink;
    }
  })();

  // Open button label
  const openLabel = isHtmlFile || hasLocalhostUrl ? 'Open Preview' : url ? 'Open Link' : 'Open File';

  // File viewer state
  const [fileViewerVisible, setFileViewerVisible] = useState(false);

  // Expandable content state
  const [expanded, setExpanded] = useState(false);
  const hasExpandableContent = !!(content || (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output?.trim()));
  const chevronRotation = useSharedValue(0);

  useEffect(() => {
    chevronRotation.value = withTiming(expanded ? 1 : 0, { duration: 200 });
  }, [expanded]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
  }));

  const handleOpen = useCallback(() => {
    if (!canOpen || !sandboxId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (hasLocalhostUrl && localhostMatch) {
      const port = parseInt(localhostMatch[1], 10);
      const urlPath = localhostMatch[2] || '';
      const proxyUrl = getSandboxPortUrl(sandboxId, String(port)) + urlPath;
      useTabStore.getState().navigateToPage('page:browser');
      useTabStore.getState().setTabState('page:browser', {
        savedUrl: proxyUrl,
        savedDisplay: `localhost:${port}${urlPath}`,
      });
    } else if (url) {
      // External URL — open in browser page
      useTabStore.getState().navigateToPage('page:browser');
      useTabStore.getState().setTabState('page:browser', {
        savedUrl: url,
        savedDisplay: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      });
    } else if (path) {
      // Open file in the file viewer (supports download)
      setFileViewerVisible(true);
    }
  }, [canOpen, sandboxId, hasLocalhostUrl, localhostMatch, url, path]);

  // Expands instantly; only the revealed content fades in (see `entering`).
  const handleToggle = useCallback(() => {
    if (!hasExpandableContent) return;
    setExpanded((prev) => !prev);
  }, [hasExpandableContent]);

  const borderColor = isError
    ? (isDark ? withAlpha(THEME.dark.destructive, 0.2) : withAlpha(THEME.light.destructive, 0.15))
    : (isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08));

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor,
        backgroundColor: cardBg(isDark),
        marginBottom: 6,
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        {/* Icon */}
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 10,
          }}
        >
          {isRunning ? (
            <KortixLoader customSize={16} />
          ) : (
            <IconComponent size={16} color={mutedStrong(isDark)} />
          )}
        </View>

        {/* Title + Description */}
        <View style={{ flex: 1, minWidth: 0 }}>
          {isRunning ? (
            <ShimmerStatusText text="Preparing output..." size="sm" />
          ) : (
            <>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: fg(isDark),
                }}
              >
                {displayTitle}
              </Text>
              {description ? (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11,
                    fontFamily: 'Roobert',
                    color: muted(isDark),
                    lineHeight: 15,
                  }}
                >
                  {description}
                </Text>
              ) : null}
            </>
          )}
        </View>

        {/* Open button — for URLs, localhost, and file paths */}
        {!isRunning && canOpen && (
          <Button
            variant="ghost"
            className="h-auto w-auto gap-0 rounded-lg p-0 active:bg-transparent active:opacity-70"
            onPress={handleOpen}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
              marginLeft: 8,
            }}
          >
            <ExternalLink size={12} color={fg(isDark)} style={{ marginRight: 4 }} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
              {openLabel}
            </Text>
          </Button>
        )}
      </View>

      {/* ── Inline image preview (like web) ── */}
      {!isRunning && type === 'image' && path && isImagePath(path) && (
        <SandboxImage filePath={path} isDark={isDark} height={260} />
      )}

      {/* ── Expand toggle for non-image content ── */}
      {hasExpandableContent && !isRunning && !(type === 'image' && path && isImagePath(path)) && (
        <>
          <Button
            variant="ghost"
            className="h-auto w-auto gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
            onPress={handleToggle}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04),
            }}
          >
            <ReAnimated.View style={chevronStyle}>
              <ChevronDown size={14} color={muted(isDark)} />
            </ReAnimated.View>
            <Text
              style={{
                marginLeft: 6,
                fontSize: 12,
                fontFamily: 'Roobert-Medium',
                color: muted(isDark),
              }}
            >
              {expanded ? 'Hide Content' : 'Show Content'}
            </Text>
          </Button>

          {expanded && (
            <ReAnimated.View
              entering={FadeIn.duration(150)}
              style={{
                borderTopWidth: 1,
                borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04),
              }}
            >
              <ShowExpandedContent tool={tool} isDark={isDark} />
            </ReAnimated.View>
          )}
        </>
      )}

      {/* File Viewer modal */}
      {path && (
        <FileViewer
          visible={fileViewerVisible}
          onClose={() => setFileViewerVisible(false)}
          file={{ name: path.split('/').pop() || 'file', path, type: 'file' } as SandboxFile}
          sandboxId={sandboxId || ''}
          sandboxUrl={ctxSandboxUrl}
        />
      )}
    </View>
  );
});
