/**
 * A Mermaid fence in a message — web's `components/ui/mermaid-renderer.tsx`.
 *
 * - While the fence is still streaming, and until the diagram has rendered,
 *   the block is the regular code block, so nothing jumps while text arrives.
 * - Once rendered, the SVG shows in a static WebView (no script, no scrolling,
 *   no touches) inside web's card: `bg-background`, 1px border, `rounded-lg`,
 *   200px minimum height. The WebView height comes from the SVG viewBox, so
 *   the row has its final height before the page loads.
 * - Tap opens the diagram full screen with pinch zoom. Long press, or the copy
 *   button, copies the source.
 * - A diagram Mermaid rejects (syntax error, unknown type, timeout) stays a
 *   code block.
 */
import * as Clipboard from 'expo-clipboard';
import React, { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { WebView } from 'react-native-webview';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { CopyIcon, XIcon } from '@/lib/icons';
import { log } from '@/lib/logger';
import { RADIUS, web } from '@/lib/markdown/markdown-layout';
import { THEME, withAlpha } from '@/lib/utils/theme';

import { CodeBlock } from '../code-block';
import { CopyButton } from '../copy-button';
import { markdownPalette } from '../markdown-theme';
import { allowInlineDocumentLoad, displayHtml, mermaidDisplayHeight } from './mermaid-html';
import {
  mermaidRenderQueue,
  type MermaidDiagram,
  type MermaidOutcome,
} from './mermaid-render-queue';
import { MermaidRendererPortal } from './MermaidRendererHost';

/** Web: `style={{ minHeight: '200px' }}` on the diagram card. */
const CARD_MIN_HEIGHT = 200;
const ORIGIN_WHITELIST = ['*'];

export interface MermaidBlockProps {
  chart: string;
  /** The fence language as written (`mermaid`, or empty for a detected diagram). */
  language: string;
  isDark: boolean;
  /** The fence has no closing marker yet. */
  isStreaming?: boolean;
}

/** The render outcome for `chart`: from the cache at once, otherwise after the renderer answers. */
function useMermaidOutcome(chart: string, enabled: boolean): MermaidOutcome | null {
  const [state, setState] = useState<{ chart: string; outcome: MermaidOutcome | null }>(() => ({
    chart,
    outcome: enabled ? mermaidRenderQueue.peek(chart) : null,
  }));

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void mermaidRenderQueue.render(chart).then((outcome) => {
      if (live) setState({ chart, outcome });
    });
    return () => {
      live = false;
    };
  }, [chart, enabled]);

  if (!enabled) return null;
  return state.chart === chart ? state.outcome : mermaidRenderQueue.peek(chart);
}

export const MermaidBlock = memo(function MermaidBlock({
  chart,
  language,
  isDark,
  isStreaming = false,
}: MermaidBlockProps) {
  const outcome = useMermaidOutcome(chart, !isStreaming);
  return (
    <>
      {/* Keeps the shared renderer WebView mounted while this block can ask it for a render. */}
      {isStreaming ? null : <MermaidRendererPortal />}
      {outcome?.ok ? (
        <MermaidDiagramCard chart={chart} diagram={outcome.diagram} isDark={isDark} />
      ) : (
        <CodeBlock code={chart} language={language} isDark={isDark} isStreaming={isStreaming} />
      )}
    </>
  );
});

async function copySource(chart: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(chart);
    haptics.success();
    return true;
  } catch (error) {
    log.error('Failed to copy diagram source:', error);
    return false;
  }
}

function MermaidDiagramCard({
  chart,
  diagram,
  isDark,
}: {
  chart: string;
  diagram: MermaidDiagram;
  isDark: boolean;
}) {
  const palette = markdownPalette(isDark);
  const background = (isDark ? THEME.dark : THEME.light).background;
  const [width, setWidth] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(Math.round(event.nativeEvent.layout.width));
  }, []);
  const open = useCallback(() => {
    haptics.tap();
    setFullscreen(true);
  }, []);
  const copy = useCallback(() => void copySource(chart), [chart]);

  const height = width > 0 ? mermaidDisplayHeight(diagram.viewBox, width) : 0;

  return (
    <>
      {/*
        Pressable, not Button: the whole diagram is the tap and long-press
        target, and it must not dim or scale like a button.
      */}
      <Pressable
        onPress={open}
        onLongPress={copy}
        accessibilityRole="imagebutton"
        accessibilityLabel="Diagram"
        accessibilityHint="Opens the diagram full screen. Long press copies its source."
        style={{
          minHeight: CARD_MIN_HEIGHT,
          backgroundColor: background,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: RADIUS.lg,
          overflow: 'hidden',
        }}>
        <View onLayout={onLayout} pointerEvents="none" style={{ height }}>
          {width > 0 ? (
            <WebView
              source={{ html: displayHtml(diagram.svg) }}
              originWhitelist={ORIGIN_WHITELIST}
              onShouldStartLoadWithRequest={allowInlineDocumentLoad}
              javaScriptEnabled={false}
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              // Android scales page text with the system font size; the height
              // above assumes the SVG's own metrics.
              textZoom={100}
              cacheEnabled={false}
              style={{ backgroundColor: 'transparent' }}
            />
          ) : null}
        </View>
        <View
          style={{
            position: 'absolute',
            top: web(2),
            right: web(2),
            borderRadius: RADIUS.md,
            backgroundColor: withAlpha(background, 0.9),
          }}>
          <CopyButton code={chart} color={palette.strong} />
        </View>
      </Pressable>
      {fullscreen ? (
        <MermaidFullscreen svg={diagram.svg} onCopy={copy} onClose={() => setFullscreen(false)} />
      ) : null}
    </>
  );
}

/** Web's fullscreen modal (`h-[90vh]`): the diagram fitted to the screen, pinch to zoom. */
function MermaidFullscreen({
  svg,
  onCopy,
  onClose,
}: {
  svg: string;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onClose();
    },
    [onClose]
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0"
        style={{ width: windowWidth - 32, height: Math.round(windowHeight * 0.9) }}>
        <View className="flex-row items-center justify-between pl-4 pr-1 pt-1">
          <DialogTitle>Diagram</DialogTitle>
          <View className="flex-row">
            <Button
              variant="ghost"
              size="icon"
              onPress={onCopy}
              accessibilityLabel="Copy diagram source">
              <Icon as={CopyIcon} size={18} />
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" accessibilityLabel="Close">
                <Icon as={XIcon} size={18} />
              </Button>
            </DialogClose>
          </View>
        </View>
        <WebView
          source={{ html: displayHtml(svg, { zoomable: true }) }}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={allowInlineDocumentLoad}
          javaScriptEnabled={false}
          scalesPageToFit
          setBuiltInZoomControls
          setDisplayZoomControls={false}
          textZoom={100}
          bounces={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          cacheEnabled={false}
          style={{ flex: 1, backgroundColor: 'transparent' }}
        />
      </DialogContent>
    </Dialog>
  );
}
