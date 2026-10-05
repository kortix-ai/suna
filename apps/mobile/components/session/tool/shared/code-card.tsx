/**
 * Code and markdown payloads under a tool row.
 *
 * Mirrors apps/web `tool/shared/infrastructure.tsx`:
 * - `ToolCodeCard` — `mt-1.5` seam + tool indent, the card frame
 *   (`border-border bg-popover rounded-md border`), a copy button pinned
 *   top-right, and a `max-h-96` scroll body with `p-3 pr-11` around Shiki
 *   highlighted source (`HighlightedCode`, the app's `min-light` / `min-dark`
 *   palette via `lib/highlight/use-code-tokens.ts`);
 * - `ToolCode` — the frameless pane for code already inside a card:
 *   `max-h-96`, `p-3`, mono `text-xs leading-[1.65] text-foreground/90`;
 * - `ToolMarkdownCard` — the same chrome as `ToolCodeCard` around rendered
 *   markdown, with YAML frontmatter shown as a key/value card above the body;
 * - `ToolMarkdown` — markdown inside a tool card (web
 *   `<div className={cn('text-sm', MD_FLUSH_CLASSES)}><UnifiedMarkdown/>`).
 */

import React, { memo, type ReactNode } from 'react';
import { Text as RNText, ScrollView, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { useCodeTokens } from '@/lib/highlight/use-code-tokens';
import { normalizeLanguage } from '@/lib/code-theme';
import { webSpace } from '@/lib/session/user-message';
import { parseFrontmatter, type FrontmatterValue } from '@/lib/session/tool-part-accessors';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { ToolCopyButton, useToolCardFrame, useToolCardPad, useToolIndent, ToolScroll } from './surface';

/**
 * Web `MD_FLUSH_CLASSES` flattens nested `<pre>` chrome inside tool markdown.
 * React Native has no descendant selectors: `ToolMarkdown` is the flush
 * markdown body, and this constant stays an empty class string so a ported
 * `cn('text-sm', MD_FLUSH_CLASSES)` compiles to a no-op.
 */
export const MD_FLUSH_CLASSES = '';

/**
 * Shiki-highlighted source as nested text. Raw React Native `Text` for the
 * token spans, as `components/markdown/code-block.tsx` does: a code block can
 * hold thousands of spans, and `ui/text` runs `cn()` per instance.
 */
export const HighlightedCode = memo(function HighlightedCode({
  code,
  language,
  color,
  typeStyle = TURN_TYPE.xsCode,
}: {
  code: string;
  language: string;
  /** Base colour for untokenised text. */
  color?: string;
  typeStyle?: { fontSize: number; lineHeight: number };
}) {
  const { colorScheme } = useColorScheme();
  const palette = useTurnPalette();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const { lines } = useCodeTokens(code, normalizeLanguage(language || 'text'), scheme);

  return (
    <RNText selectable style={[typeStyle, { fontFamily: monoFont, color: color ?? palette.foreground90 }]}>
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
  );
});

/** The frame + seam + copy button + capped scroll body every payload card shares. */
function PayloadCard({
  copyText,
  children,
  horizontal = false,
}: {
  copyText?: string;
  children: ReactNode;
  horizontal?: boolean;
}) {
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  const pad = useToolCardPad();
  const body = { padding: pad, paddingRight: copyText ? TURN_SPACE.copyReserve : pad };

  return (
    <View style={indent ? { marginTop: TURN_SPACE.gap1_5, marginLeft: indent } : undefined}>
      <View style={[{ position: 'relative', overflow: 'hidden' }, frame]}>
        <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight} showsVerticalScrollIndicator>
          {horizontal ? (
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerStyle={body}>
              {children}
            </ScrollView>
          ) : (
            <View style={body}>{children}</View>
          )}
        </ToolScroll>
        {copyText ? <ToolCopyButton text={copyText} /> : null}
      </View>
    </View>
  );
}

export function ToolCodeCard({ code, language }: { code: string; language: string }) {
  if (!code) return null;
  return (
    <PayloadCard copyText={code} horizontal>
      <HighlightedCode code={code} language={language} />
    </PayloadCard>
  );
}

export function ToolCode({ code, language }: { code: string; language: string }) {
  return (
    <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: TURN_SPACE.cardPad }}
      >
        <HighlightedCode code={code} language={language} />
      </ScrollView>
    </ToolScroll>
  );
}

/** Markdown in a tool body (web `text-sm` + `MD_FLUSH_CLASSES` + `UnifiedMarkdown`). */
export function ToolMarkdown({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
  const { colorScheme } = useColorScheme();
  return (
    <SelectableMarkdownText isDark={colorScheme === 'dark'} isStreaming={isStreaming}>
      {content}
    </SelectableMarkdownText>
  );
}

function FrontmatterScalar({ value }: { value: string }) {
  const palette = useTurnPalette();
  const v = value.replace(/^['"](.*)['"]$/, '$1');
  return (
    <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.foreground90 }]}>
      {v || '—'}
    </Text>
  );
}

/**
 * Web `MarkdownFrontmatterCard`: one row per key, the key muted, the value a
 * scalar or a wrap of `key: value` badges for a nested object.
 */
export function MarkdownFrontmatterCard({ data }: { data: Record<string, FrontmatterValue> }) {
  const palette = useTurnPalette();
  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  return (
    <View
      style={{
        marginBottom: webSpace(4),
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: TURN_SPACE.radiusMd,
        paddingHorizontal: TURN_SPACE.cardPad,
        paddingVertical: webSpace(2),
        rowGap: webSpace(1.5),
      }}
    >
      {entries.map(([key, value]) => (
        <View key={key} style={{ flexDirection: 'row', gap: webSpace(3), alignItems: 'flex-start' }}>
          <Text variant="muted" style={[TURN_TYPE.xs, { width: webSpace(24), color: palette.muted70, fontFamily: monoFont }]}>
            {key}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            {typeof value === 'string' ? (
              <FrontmatterScalar value={value} />
            ) : Object.keys(value).length === 0 ? (
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
                —
              </Text>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: webSpace(1) }}>
                {Object.entries(value).map(([k, v]) => (
                  <Badge key={k} variant="secondary">
                    <Text>
                      {k}: {v.replace(/^['"](.*)['"]$/, '$1') || '—'}
                    </Text>
                  </Badge>
                ))}
              </View>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

export function ToolMarkdownCard({ code }: { code: string }) {
  if (!code) return null;
  const { frontmatter, body } = parseFrontmatter(code);
  return (
    <PayloadCard copyText={code}>
      {frontmatter ? <MarkdownFrontmatterCard data={frontmatter} /> : null}
      <ToolMarkdown content={body} />
    </PayloadCard>
  );
}

export { PayloadCard as ToolOutputCard };
