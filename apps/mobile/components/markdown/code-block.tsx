/**
 * A fenced code block in a message — web's `components/markdown/code/
 * code-block.tsx`: a bordered card with a caption (lowercase language label +
 * copy) over a scrollable, syntax-highlighted body.
 *
 * Highlighting uses the one app palette (Shiki `min-light` / `min-dark`, see
 * `lib/highlight/shiki.ts`). While the fence is still streaming the body
 * renders plain in the theme's base colour and follows the newest line; the
 * block highlights once, when the fence closes.
 */
import React, { createContext, memo, useCallback, useContext, useEffect, useRef } from 'react';
import { Text as RNText, View, type StyleProp, type ViewStyle } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';

import { languageLabel } from '@/lib/code-theme';
import { ensureLanguage } from '@/lib/highlight/shiki';
import { useCodeTokens } from '@/lib/highlight/use-code-tokens';
import { CODE_BLOCK, RADIUS } from '@/lib/markdown/markdown-layout';

import { CopyButton } from './copy-button';
import { markdownPalette, MONO_FONT } from './markdown-theme';

export interface CodeBlockProps {
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

  const body = (
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
          color: palette.strong,
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

  return (
    <View
      style={[
        {
          backgroundColor: palette.codeFrame,
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: RADIUS.md,
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
        {code ? <CopyButton code={code} color={palette.strong} /> : null}
      </View>

      <View
        style={{
          backgroundColor: palette.codeBody,
          borderTopLeftRadius: RADIUS.sm,
          borderTopRightRadius: RADIUS.sm,
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
    </View>
  );
});
