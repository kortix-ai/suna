/**
 * Raw and lightly structured tool output.
 *
 * Mirrors apps/web `tool/shared/output-block.tsx`:
 * - `OutputBlock` — NOT a card: `bg-muted/20 rounded-sm px-3 py-2`, capped at
 *   `max-h-96` and scrollable; mono `text-xs text-muted-foreground/80`
 *   wrapped, or markdown when `markdown`;
 * - `ToolSection` — the one section label: `text-[10px] font-medium
 *   tracking-wider uppercase text-muted-foreground/60`, `space-y-1`;
 * - `FoldedSection` — the same label as a disclosure trigger with a
 *   `size-3` caret, closed by default, body `pt-1`;
 * - `ToolField` — `label` (`text-muted-foreground/60`) · value
 *   (`text-foreground/80`, truncating, optional mono), `text-xs gap-2`.
 *
 * `MonoBlock` / `OutputSection` are the previous mobile renderers' blocks,
 * kept until those renderers are ported.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '@/components/ui/text';
import { DisclosureContent } from '@/components/session/chain-of-thought';
import { webSpace } from '@/lib/session/user-message';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { ToolMarkdown } from './code-card';
import {
  FONT_MEDIUM,
  TURN_SPACE,
  TURN_TYPE,
  monoFont,
  muted,
  mutedBg,
  mutedStrong,
  useTurnPalette,
} from './styles';
import { ToolCaret, ToolScroll } from './surface';

export function OutputBlock({
  text,
  markdown = false,
  style,
}: {
  text: string;
  markdown?: boolean;
  /** Web `className`. */
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useTurnPalette();
  return (
    <View style={[{ backgroundColor: palette.muted20Bg, borderRadius: TURN_SPACE.radiusSm, overflow: 'hidden' }, style]}>
      <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight} contentContainerStyle={{ paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2) }}>
        {markdown ? (
          <ToolMarkdown content={text} />
        ) : (
          <Text variant="muted" selectable style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted80 }]}>
            {text}
          </Text>
        )}
      </ToolScroll>
    </View>
  );
}

function SectionLabel({ children, color }: { children: ReactNode; color: string }) {
  return (
    <Text
      variant="small"
      style={[TURN_TYPE.label10, { fontFamily: FONT_MEDIUM, textTransform: 'uppercase', color }]}
    >
      {children}
    </Text>
  );
}

export function ToolSection({
  label,
  children,
  style,
}: {
  label: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useTurnPalette();
  return (
    <View style={[{ rowGap: webSpace(1) }, style]}>
      <SectionLabel color={palette.muted60}>{label}</SectionLabel>
      {children}
    </View>
  );
}

export function FoldedSection({
  label,
  children,
  defaultOpen = false,
  style,
}: {
  label: ReactNode;
  children: ReactNode;
  /** Closed is the point. Pass `true` only where the fold is a courtesy. */
  defaultOpen?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={[{ rowGap: webSpace(1) }, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1) }}
      >
        <ToolCaret open={open} color={palette.muted60} size={TURN_SPACE.statusIcon} />
        {typeof label === 'string' ? <SectionLabel color={palette.muted60}>{label}</SectionLabel> : label}
      </Pressable>
      <DisclosureContent open={open}>
        <View style={{ paddingTop: webSpace(1) }}>{children}</View>
      </DisclosureContent>
    </View>
  );
}

export function ToolField({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  const palette = useTurnPalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: webSpace(2) }}>
      <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, color: palette.muted60 }]}>
        {label}
      </Text>
      <Text
        variant="muted"
        numberOfLines={1}
        style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.foreground80 }, mono && { fontFamily: monoFont }]}
      >
        {value}
      </Text>
    </View>
  );
}

// ─── MonoBlock — reusable monospace code block ───────────────────────────────

export function MonoBlock({
  children,
  isDark,
  color,
  maxLines,
}: {
  children: string;
  isDark: boolean;
  color?: string;
  maxLines?: number;
}) {
  return (
    <Text
      numberOfLines={maxLines}
      style={{
        fontSize: 11,
        fontFamily: monoFont,
        lineHeight: 17,
        color: color || mutedStrong(isDark),
      }}
    >
      {children}
    </Text>
  );
}

// ─── OutputSection — "OUTPUT" label + content block ──────────────────────────

export function OutputSection({
  output,
  isDark,
  isError,
}: {
  output: string;
  isDark: boolean;
  isError?: boolean;
}) {
  const displayOutput = output.length > 3000 ? output.slice(0, 3000) + '\n...' : output;
  return (
    <View
      style={{
        marginHorizontal: 10,
        marginBottom: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.04),
        backgroundColor: mutedBg(isDark),
        overflow: 'hidden',
      }}
    >
      {/* Label */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}>
        <View
          style={{
            width: 5,
            height: 5,
            borderRadius: 2.5,
            backgroundColor: isError ? (isDark ? THEME.dark.destructive : THEME.light.destructive) : muted(isDark),
            marginRight: 6,
          }}
        />
        <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {isError ? 'Error' : 'Output'}
        </Text>
      </View>
      {/* Content */}
      <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
        <MonoBlock isDark={isDark} color={isError ? (isDark ? THEME.dark.destructive : THEME.light.destructive) : undefined} maxLines={30}>
          {displayOutput}
        </MonoBlock>
      </View>
    </View>
  );
}
