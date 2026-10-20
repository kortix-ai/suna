/**
 * A fenced code block in a message — web's `components/markdown/code/
 * code-block.tsx`: a bordered card with a caption (lowercase language label,
 * then copy and full screen) over a scrollable, syntax-highlighted body. Full
 * screen opens the code in the app's bottom sheet (`CodeSheet`): title, Copy
 * at the far right, the whole block scrolling vertically, as the file preview.
 *
 * Highlighting uses the one app palette (Shiki `min-light` / `min-dark`, see
 * `lib/highlight/shiki.ts`). While the fence is still streaming the body
 * renders plain in the theme's base colour and follows the newest line; the
 * block highlights once, when the fence closes.
 */
import React, { createContext, memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Pressable, Text as RNText, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { BottomSheetScrollView, type BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CopyContentButton, KortixBottomSheetModal } from '@/components/kortix/sheet';
import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { ArrowsOutSimpleIcon } from '@/lib/icons';

import { languageLabel } from '@/lib/code-theme';
import { ensureLanguage } from '@/lib/highlight/shiki';
import { useCodeTokens } from '@/lib/highlight/use-code-tokens';
import { CODE_BLOCK, MARKDOWN_BORDER_WIDTH } from '@/lib/markdown/markdown-layout';

import { CopyButton } from './copy-button';
import { markdownPalette, MONO_FONT } from './markdown-theme';

interface CodeBlockProps {
  code: string;
  /** The fence's info-string language hint, raw (`ts`, `py`, `""`). */
  language: string;
  isDark: boolean;
  /** The fence has no closing marker yet: render plain and pin to the newest line. */
  isStreaming?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Strip one trailing newline, as markdown-it's fence content always ends with one. */
export function fenceCode(content: unknown): string {
  const text = typeof content === 'string' ? content : '';
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** The first word of a fence info string (`ts title="x"` → `ts`). */
export function fenceLanguage(info: unknown): string {
  return typeof info === 'string' ? (info.trim().split(/\s+/)[0] ?? '') : '';
}

/**
 * `true` inside a surface that already scrolls vertically (the activity
 * sheet's detail view). The body then renders at full height, so the one
 * outer scroller moves it; a capped inner scroller would trap the gesture.
 */
export const CodeBlockFullHeightContext = createContext(false);

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  isDark,
  isStreaming = false,
  style,
}: CodeBlockProps) {
  const palette = markdownPalette(isDark);
  const scheme = isDark ? 'dark' : 'light';
  const { lines } = useCodeTokens(code, language || 'text', scheme, { enabled: !isStreaming });

  // Load the grammar while the fence streams, so the block colours in the
  // same frame its closing fence arrives instead of one grammar-load later.
  useEffect(() => {
    if (isStreaming && language) void ensureLanguage(language);
  }, [isStreaming, language]);

  const fullHeight = useContext(CodeBlockFullHeightContext);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Web pins the scroll to the newest lines while tokens arrive; without it the
  // 520pt clamp holds the reader at the top of a block growing underneath.
  const onContentSizeChange = useCallback(() => {
    if (isStreaming) scrollRef.current?.scrollToEnd({ animated: false });
  }, [isStreaming]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = useCallback(() => {
    haptics.tap();
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const body = <CodeLines lines={lines} color={palette.strong} />;

  return (
    <View
      style={[
        {
          backgroundColor: palette.codeFrame,
          // The markdown table's hairline (`MARKDOWN_BORDER_WIDTH`, `palette.border`).
          borderColor: palette.border,
          borderWidth: MARKDOWN_BORDER_WIDTH,
          borderRadius: CODE_BLOCK.radius,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View
        style={{
          minHeight: CODE_BLOCK.captionMinHeight,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          paddingHorizontal: CODE_BLOCK.captionPaddingX,
          paddingVertical: CODE_BLOCK.captionPaddingY,
        }}
      >
        <RNText
          selectable={false}
          accessibilityLabel={`${languageLabel(language)} code`}
          style={{
            fontFamily: MONO_FONT,
            fontSize: CODE_BLOCK.captionFontSize,
            fontWeight: '500',
            letterSpacing: CODE_BLOCK.captionLetterSpacing,
            textTransform: 'lowercase',
            color: palette.muted,
          }}
        >
          {languageLabel(language)}
        </RNText>
        {code ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <CopyButton code={code} color={palette.strong} />
            {/* Inside a sheet that already scrolls the whole block: no second sheet. */}
            {fullHeight ? null : <ExpandButton color={palette.strong} onPress={openSheet} />}
          </View>
        ) : null}
      </View>

      <View
        style={{
          backgroundColor: palette.codeBody,
          borderTopLeftRadius: CODE_BLOCK.bodyRadius,
          borderTopRightRadius: CODE_BLOCK.bodyRadius,
        }}
      >
        {fullHeight ? (
          body
        ) : (
          <ScrollView
            ref={scrollRef}
            style={{ maxHeight: CODE_BLOCK.bodyMaxHeight }}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            onContentSizeChange={onContentSizeChange}
          >
            {body}
          </ScrollView>
        )}
      </View>
      {/* Mounted only while open: a transcript holds many code blocks. */}
      {sheetOpen ? (
        <CodeSheet
          code={code}
          title={languageLabel(language)}
          lines={lines}
          color={palette.strong}
          onDismiss={closeSheet}
        />
      ) : null}
    </View>
  );
});

type CodeTokenLines = ReturnType<typeof useCodeTokens>['lines'];

/** The highlighted lines, scrolling sideways: the block's body and the sheet's. */
function CodeLines({ lines, color }: { lines: CodeTokenLines; color: string }) {
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: CODE_BLOCK.bodyPaddingX,
        paddingVertical: CODE_BLOCK.bodyPaddingY,
      }}
    >
      <RNText
        selectable
        style={{
          fontFamily: MONO_FONT,
          fontSize: CODE_BLOCK.fontSize,
          lineHeight: CODE_BLOCK.lineHeight,
          letterSpacing: CODE_BLOCK.letterSpacing,
          color,
        }}
      >
        {lines.map((line, lineIndex) => (
          <React.Fragment key={lineIndex}>
            {lineIndex > 0 ? '\n' : null}
            {line.map((token, tokenIndex) => (
              <RNText key={tokenIndex} style={{ color: token.color }}>
                {token.content}
              </RNText>
            ))}
          </React.Fragment>
        ))}
      </RNText>
    </ScrollView>
  );
}

/** Spread to the 44pt minimum touch target around the 32pt visible button. */
const EXPAND_HIT_SLOP = (44 - CODE_BLOCK.copyButtonSize) / 2;

/** Full screen: the copy button's twin (size, press fill, touch target), beside it. */
function ExpandButton({ color, onPress }: { color: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={EXPAND_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel="Open code full screen"
      className="items-center justify-center rounded-full active:bg-accent"
      style={{ width: CODE_BLOCK.copyButtonSize, height: CODE_BLOCK.copyButtonSize }}
    >
      <Icon as={ArrowsOutSimpleIcon} size={CODE_BLOCK.copyIconSize} color={color} />
    </Pressable>
  );
}

/** Gorhom wants a stable array. Opens at full screen, as the file preview. */
const FULL_SCREEN = ['100%'];

/**
 * The whole block in the app's bottom sheet: the language as the title, Copy
 * at the far right (`CopyContentButton`), the code below on the sheet itself
 * (no card, no border: Jay, 2026-10-20), scrolling vertically at full height
 * and sideways per line. Presents on mount; swipe down closes.
 */
function CodeSheet({
  code,
  title,
  lines,
  color,
  onDismiss,
}: {
  code: string;
  title: string;
  lines: CodeTokenLines;
  color: string;
  onDismiss: () => void;
}) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    sheetRef.current?.present();
  }, []);
  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      title={title}
      titleTrailing={<CopyContentButton text={code} label="Copy code" />}
      snapPoints={FULL_SCREEN}
      enableDynamicSizing={false}
      enablePanDownToClose
      onDismiss={onDismiss}
    >
      {/* The lines' own 14.72pt side padding keeps the code off the sheet's edges. */}
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}>
        <CodeLines lines={lines} color={color} />
      </BottomSheetScrollView>
    </KortixBottomSheetModal>
  );
}
