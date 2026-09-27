/**
 * Math in a message — web renders `$…$`, `$$…$$`, and ```math / latex / tex /
 * katex fences with KaTeX; the app draws the same TeX as SVG
 * (`lib/math/tex-to-svg.ts`, MathJax 4 with the TeX font).
 *
 * Sizes follow web's stylesheet: `.kortix-markdown .katex { font-size: 1.05em }`,
 * so one math em is 1.05 × the surrounding text size (15.75px in a paragraph).
 * Invalid TeX — an unknown macro, or a formula that is still streaming —
 * renders as the raw source in the muted colour, like KaTeX's `errorColor`
 * on web.
 */
import React, { memo, useMemo } from 'react';
import { Text as RNText, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { SvgXml } from 'react-native-svg';

import { texToSvg, type TexSvg } from '@/lib/math/tex-to-svg';
import { RADIUS, TYPE, web } from '@/lib/markdown/markdown-layout';
import { FONT_FAMILY } from '@/lib/utils/fonts';

import { markdownPalette, MONO_FONT } from './markdown-theme';

/** `.kortix-markdown .katex { font-size: 1.05em }`. */
export const MATH_EM_SCALE = 1.05;

/** One math em in a paragraph: 15 × 1.05. */
export const BLOCK_MATH_FONT_SIZE = TYPE.body.fontSize * MATH_EM_SCALE;

function useTexSvg(tex: string, display: boolean): TexSvg | null {
  return useMemo(() => {
    try {
      return texToSvg(tex, display);
    } catch {
      return null;
    }
  }, [tex, display]);
}

/** viewBox units (1/1000 em) → px at `fontSize`. */
function px(units: number, fontSize: number): number {
  return (units / 1000) * fontSize;
}

export interface InlineMathProps {
  tex: string;
  isDark: boolean;
  /** Size of the text around the formula; the math em is 1.05× this. */
  fontSize?: number;
  /** Colour of the text around the formula (`currentColor` in the SVG). */
  color?: string;
}

/**
 * `$…$` inside a line of text. React Native bottom-aligns an inline view on
 * the text baseline (RCTTextLayoutManager.mm, TextInlineViewPlaceholderSpan.kt),
 * so the SVG shifts down by its depth to put the formula's baseline on the
 * text's baseline.
 */
export const InlineMath = memo(function InlineMath({
  tex,
  isDark,
  fontSize = TYPE.body.fontSize,
  color,
}: InlineMathProps) {
  const svg = useTexSvg(tex, false);
  const palette = markdownPalette(isDark);

  if (!svg) {
    return <RNText style={{ color: palette.muted }}>{tex}</RNText>;
  }

  const em = fontSize * MATH_EM_SCALE;
  const width = px(svg.width, em);
  const height = px(svg.height, em);
  return (
    <View
      accessible
      accessibilityLabel={tex}
      style={{ width, height, transform: [{ translateY: px(svg.depth, em) }] }}>
      <SvgXml xml={svg.xml} width={width} height={height} color={color ?? palette.text} />
    </View>
  );
});

export interface BlockMathProps {
  tex: string;
  isDark: boolean;
  /**
   * `fence`: a ```math / latex / tex / katex block — web's `KaTeXBlock`, `py-3`
   * around the formula and a bordered code-style box on error.
   * `display` (default): `$$…$$` — web's `.katex-display`; the block's 1em
   * margins come from `markdown-layout.ts` (`math`).
   */
  variant?: 'display' | 'fence';
}

/**
 * Display math: centred, scrolling sideways when wider than the message
 * (`.katex-display { overflow-x: auto }`).
 */
export const BlockMath = memo(function BlockMath({
  tex,
  isDark,
  variant = 'display',
}: BlockMathProps) {
  const source = variant === 'fence' ? tex.trim() : tex;
  const svg = useTexSvg(source, true);
  const palette = markdownPalette(isDark);

  if (!svg) {
    if (variant === 'fence') {
      // Web: `border-border bg-muted text-muted-foreground rounded-md border px-4 py-3 font-mono text-sm`.
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{
            borderWidth: 1,
            borderColor: palette.border,
            backgroundColor: palette.tableHeader,
            borderRadius: RADIUS.md,
          }}
          contentContainerStyle={{ paddingHorizontal: web(4), paddingVertical: web(3) }}>
          <RNText
            selectable
            style={{
              fontFamily: MONO_FONT,
              fontSize: TYPE.sm.fontSize,
              lineHeight: TYPE.sm.lineHeight,
              letterSpacing: -0.35,
              color: palette.muted,
            }}>
            {source}
          </RNText>
        </ScrollView>
      );
    }
    // Web: KaTeX's `span.katex-error`, the raw TeX in the message's 15px text.
    return (
      <RNText
        selectable
        style={{
          fontFamily: FONT_FAMILY.regular,
          fontSize: TYPE.body.fontSize,
          lineHeight: TYPE.body.lineHeight,
          color: palette.muted,
        }}>
        {source}
      </RNText>
    );
  }

  const width = px(svg.width, BLOCK_MATH_FONT_SIZE);
  const height = px(svg.height, BLOCK_MATH_FONT_SIZE);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        paddingVertical: variant === 'fence' ? web(3) : 0,
      }}>
      <View accessible accessibilityLabel={source} style={{ width, height }}>
        <SvgXml xml={svg.xml} width={width} height={height} color={palette.strong} />
      </View>
    </ScrollView>
  );
});
