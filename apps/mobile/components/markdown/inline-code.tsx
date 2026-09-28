/**
 * Inline code in a message — web's `components/markdown/code/inline-code.tsx`
 * and `inline-chip.tsx`.
 *
 * - A hex colour gets a swatch of the colour in front of the value.
 * - A URL opens in the browser (http, https, mailto only — `safe-link.ts`).
 * - A file path opens through `MarkdownActions.onOpenFile` when the screen
 *   provides one; without a provider it stays plain.
 * - Inside a markdown link the chip never takes the press: the link does.
 *
 * The chip is an inline `View` inside the paragraph `Text`. A nested Text
 * cannot draw a border, a radius, or padding, and web's chip has all three.
 * Metrics are `INLINE_CODE`; the baseline placement per platform is
 * `inlineCodeAnchor` (both in markdown-layout.ts).
 *
 * An inline view never wraps, so a long span is drawn as several chips side
 * by side (`splitInlineCode`). A line can break between two of them. Only the
 * first piece draws the left edge and only the last draws the right edge, so
 * pieces on one line read as one chip, and a chip cut by a line break is open
 * at the cut — web's default `box-decoration-break: slice`.
 *
 * Cost: the chip's text is its own selectable `Text`. Selecting or copying
 * the surrounding paragraph does not include the code.
 */
import React, { createContext, useContext } from 'react';
import { Platform, Text as RNText, useWindowDimensions, View } from 'react-native';

import { classifyInlineCode, splitInlineCode } from '@/lib/markdown/inline-code';
import { INLINE_CODE, inlineCodeAnchor, RADIUS, TYPE } from '@/lib/markdown/markdown-layout';
import { isSafeExternalLink } from '@/lib/markdown/safe-link';

import { markdownPalette, MONO_FONT, type MarkdownPalette } from './markdown-theme';
import { openLink } from '@/lib/utils/open-link';

export interface MarkdownActions {
  /** Open a file path mentioned in a message (e.g. in the session file viewer). */
  onOpenFile?: (path: string) => void;
}

const MarkdownActionsContext = createContext<MarkdownActions>({});

/** Lets a screen make file paths in rendered markdown tappable. */
export const MarkdownActionsProvider = MarkdownActionsContext.Provider;

export function useMarkdownActions(): MarkdownActions {
  return useContext(MarkdownActionsContext);
}

/** Text style of the line the chip sits in. */
export interface InlineCodeLine {
  fontSize?: number;
  lineHeight?: number;
}

/**
 * U+200D ZERO WIDTH JOINER, iOS only. TextKit takes a paragraph's line height
 * from its FIRST character, and React Native gives an inline view's character
 * no paragraph style, so a paragraph that opened with a chip lost its 24.38px
 * line height (measured: 21.71px). This joiner carries the line's style in
 * front of every chip. It is set in the system font because Roobert has no
 * glyph for it, and a fallback font moved the baseline 2px. Line breaking: a
 * joiner never breaks from what follows it, and after a space it breaks like
 * a letter, so the chip still wraps as a word.
 */
const JOINER = '‍';

/**
 * A square of the colour, on a checkerboard so an alpha hex reads as
 * translucent, with a ring so `#fff` shows on a light chip. Its bottom edge
 * sits on the chip text's baseline, like web's `align-baseline`.
 */
function HexSwatch({ hex, palette, baseline }: { hex: string; palette: MarkdownPalette; baseline: number }) {
  const half = INLINE_CODE.swatchSize / 2;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: INLINE_CODE.swatchSize,
        height: INLINE_CODE.swatchSize,
        marginRight: INLINE_CODE.swatchGap,
        marginBottom: baseline,
        borderRadius: RADIUS.swatch,
        overflow: 'hidden',
      }}
    >
      <View style={{ position: 'absolute', left: 0, top: 0, width: half, height: half, backgroundColor: palette.swatchChecker }} />
      <View style={{ position: 'absolute', left: half, top: half, width: half, height: half, backgroundColor: palette.swatchChecker }} />
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          backgroundColor: hex,
          borderRadius: RADIUS.swatch,
          borderWidth: 1,
          borderColor: palette.swatchRing,
        }}
      />
    </View>
  );
}

export function InlineCode({
  code,
  isDark,
  insideLink = false,
  line = TYPE.body,
}: {
  code: string;
  isDark: boolean;
  /** Rendered inside a markdown link: the link handles the press. */
  insideLink?: boolean;
  /** Font size and line height of the surrounding text. Defaults to message body text. */
  line?: InlineCodeLine;
}) {
  const palette = markdownPalette(isDark);
  const { onOpenFile } = useMarkdownActions();
  // System text size scales the chip's text line; border and padding stay fixed.
  const { fontScale } = useWindowDimensions();
  const text = code.trim();
  const kind = classifyInlineCode(text);

  let onPress: (() => void) | undefined;
  if (!insideLink && kind === 'url' && isSafeExternalLink(text)) {
    onPress = () => {
      openLink(text).catch(() => {});
    };
  } else if (!insideLink && kind === 'path' && onOpenFile) {
    onPress = () => onOpenFile(text);
  }

  const anchor = inlineCodeAnchor(Platform.OS, line, fontScale);
  const textBaseline = INLINE_CODE.textBaselineFromBottom * fontScale;
  const pieces = kind === 'hex' ? [code] : splitInlineCode(code);
  const last = pieces.length - 1;

  return (
    <>
      {Platform.OS === 'ios' ? (
        <RNText style={{ fontFamily: 'System', fontSize: line.fontSize, lineHeight: line.lineHeight }}>{JOINER}</RNText>
      ) : null}
      {pieces.map((piece, index) => {
        const isFirst = index === 0;
        const isLast = index === last;
        const startRadius = isFirst ? RADIUS.inlineCode : 0;
        const endRadius = isLast ? RADIUS.inlineCode : 0;
        return (
          // The inline view is the whole chip; nothing renders outside it,
          // because Android clips children to their parent's bounds.
          <View
            key={index}
            // One accessibility element for the whole span: the first piece
            // carries the full text, the others are hidden.
            accessibilityElementsHidden={!isFirst}
            importantForAccessibility={isFirst ? 'auto' : 'no-hide-descendants'}
            style={{
              height: anchor.height,
              overflow: 'visible',
              transform: [{ translateY: anchor.translateY }],
            }}
          >
            <View
              style={{
                flexShrink: 0,
                flexDirection: 'row',
                alignItems: 'flex-end',
                backgroundColor: palette.inlineCodeBg,
                borderColor: palette.border,
                borderTopWidth: INLINE_CODE.borderWidth,
                borderBottomWidth: INLINE_CODE.borderWidth,
                borderLeftWidth: isFirst ? INLINE_CODE.borderWidth : 0,
                borderRightWidth: isLast ? INLINE_CODE.borderWidth : 0,
                borderTopLeftRadius: startRadius,
                borderBottomLeftRadius: startRadius,
                borderTopRightRadius: endRadius,
                borderBottomRightRadius: endRadius,
                paddingLeft: isFirst ? INLINE_CODE.paddingX : 0,
                paddingRight: isLast ? INLINE_CODE.paddingX : 0,
                paddingVertical: INLINE_CODE.paddingY,
              }}
            >
              {kind === 'hex' ? <HexSwatch hex={text} palette={palette} baseline={textBaseline} /> : null}
              <RNText
                selectable={!insideLink}
                numberOfLines={1}
                onPress={onPress}
                accessibilityRole={onPress ? (kind === 'url' ? 'link' : 'button') : undefined}
                accessibilityLabel={isFirst && last > 0 ? code : undefined}
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: INLINE_CODE.fontSize,
                  lineHeight: INLINE_CODE.lineHeight,
                  fontWeight: '500',
                  letterSpacing: INLINE_CODE.letterSpacing,
                  color: palette.text,
                  includeFontPadding: false,
                }}
              >
                {piece}
              </RNText>
            </View>
          </View>
        );
      })}
    </>
  );
}
