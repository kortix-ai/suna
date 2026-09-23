/**
 * Log-like tool output as typed sections.
 *
 * Mirrors apps/web `tool/shared/structured-output.tsx` (sections from
 * `parseStructuredOutput`, `lib/session/tool-output-parsers.ts`), `space-y-1.5
 * p-2.5`:
 * - warning — `rounded-md border px-2.5 py-1.5`, `border-kortix-yellow
 *   bg-kortix-yellow/10`, `Warning` `size-4` + mono `text-xs leading-relaxed`
 *   in the warning tone;
 * - error — `bg-muted/40 border-border/60`, `Prohibit` `size-3`
 *   `text-muted-foreground/70`, optional type (`text-xs font-semibold
 *   uppercase tracking-wider`), mono summary `text-muted-foreground`;
 * - traceback — a "Stack trace · N lines" toggle (`size-3` caret, `px-2
 *   py-1`), opening a `max-h-64` mono pane (`text-muted-foreground/60`,
 *   `File "…"` lines at `/80`);
 * - install — `border-kortix-green bg-kortix-green/10`, `CheckCircle`
 *   `size-3` + mono text in the success tone;
 * - info — `size-1` dot (`bg-muted-foreground/30`) + mono `text-muted-foreground`;
 * - plain — mono `text-xs leading-relaxed text-foreground/70`, `px-2.5 py-1`.
 */

import { useState } from 'react';
import { Text as RNText, View } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Text } from '@/components/ui/text';
import { CheckCircleIcon, ProhibitIcon, WarningIcon } from '@/lib/icons';
import type { OutputSection } from '@/lib/session/tool-output-parsers';
import { webSpace } from '@/lib/session/user-message';
import { FONT_MEDIUM, FONT_SEMIBOLD, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { ToolCaret, ToolScroll } from './surface';

export type { OutputSection } from '@/lib/session/tool-output-parsers';

function sectionContent(section: OutputSection): string {
  switch (section.type) {
    case 'error':
      return `${section.errorType ?? ''}:${section.summary}`;
    case 'traceback':
      return section.lines.join('\n');
    default:
      return section.text;
  }
}

const SECTION_BOX = {
  flexDirection: 'row' as const,
  gap: webSpace(2),
  borderWidth: 1,
  borderRadius: TURN_SPACE.radiusMd,
  paddingHorizontal: webSpace(2.5),
  paddingVertical: webSpace(1.5),
};

export function StructuredOutput({ sections }: { sections: OutputSection[] }) {
  const palette = useTurnPalette();
  const [showTrace, setShowTrace] = useState(false);
  const mono = [TURN_TYPE.xsRelaxed, { fontFamily: monoFont }];

  const seen = new Map<string, number>();
  const keyed = sections.map((section) => {
    const base = `${section.type}:${sectionContent(section).slice(0, 80)}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { section, key: n ? `${base}#${n}` : base };
  });

  return (
    <View style={{ padding: webSpace(2.5), rowGap: webSpace(1.5) }}>
      {keyed.map(({ section, key }) => {
        switch (section.type) {
          case 'warning':
            return (
              <View
                key={key}
                style={[SECTION_BOX, { alignItems: 'flex-start', borderColor: palette.warningBorder, backgroundColor: palette.warningBg }]}
              >
                <View style={{ marginTop: webSpace(0.5) }}>
                  <WarningIcon size={TURN_SPACE.icon} color={palette.warning} />
                </View>
                <Text variant="muted" selectable style={[mono, { flex: 1, color: palette.warning }]}>
                  {section.text}
                </Text>
              </View>
            );

          case 'error':
            return (
              <View
                key={key}
                style={[SECTION_BOX, { alignItems: 'flex-start', borderColor: palette.border60, backgroundColor: palette.muted40Bg }]}
              >
                <View style={{ marginTop: webSpace(0.5) }}>
                  <ProhibitIcon size={TURN_SPACE.statusIcon} color={palette.muted70} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {section.errorType ? (
                    <Text
                      variant="muted"
                      style={[TURN_TYPE.xs, { fontFamily: FONT_SEMIBOLD, letterSpacing: 0.65, textTransform: 'uppercase', color: palette.mutedForeground }]}
                    >
                      {section.errorType}
                    </Text>
                  ) : null}
                  <Text variant="muted" selectable style={[mono, { color: palette.mutedForeground }]}>
                    {section.summary}
                  </Text>
                </View>
              </View>
            );

          case 'traceback':
            return (
              <View key={key}>
                <PressableSurface
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showTrace }}
                  onPress={() => setShowTrace((v) => !v)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: TURN_SPACE.gap1_5,
                    borderRadius: TURN_SPACE.radiusMd,
                    paddingHorizontal: webSpace(2),
                    paddingVertical: webSpace(1),
                    backgroundColor: pressed ? palette.muted30Bg : undefined,
                  })}
                >
                  <ToolCaret open={showTrace} color={palette.muted60} size={TURN_SPACE.statusIcon} />
                  <Text variant="small" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.muted60 }]}>
                    Stack trace
                  </Text>
                  <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: webSpace(1), fontFamily: monoFont, color: palette.muted40 }]}>
                    {section.lines.length} lines
                  </Text>
                </PressableSurface>
                {showTrace ? (
                  <View style={{ marginTop: webSpace(1), overflow: 'hidden' }}>
                    <ToolScroll maxHeight={webSpace(64)}>
                      <Text
                        variant="muted"
                        selectable
                        style={[mono, { padding: webSpace(2.5), color: palette.muted60 }]}
                      >
                        {section.lines.map((line, li) => (
                          <RNText key={li} style={/^\s+File "/.test(line) ? { color: palette.muted80 } : undefined}>
                            {line}
                            {'\n'}
                          </RNText>
                        ))}
                      </Text>
                    </ToolScroll>
                  </View>
                ) : null}
              </View>
            );

          case 'install':
            return (
              <View
                key={key}
                style={[SECTION_BOX, { alignItems: 'center', borderColor: palette.successBorder, backgroundColor: palette.successBg }]}
              >
                <CheckCircleIcon size={TURN_SPACE.statusIcon} color={palette.success} />
                <Text variant="muted" selectable style={[TURN_TYPE.xs, { flex: 1, fontFamily: monoFont, color: palette.success }]}>
                  {section.text}
                </Text>
              </View>
            );

          case 'info':
            return (
              <View
                key={key}
                style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(2), paddingHorizontal: webSpace(2.5), paddingVertical: webSpace(1) }}
              >
                <View style={{ width: webSpace(1), height: webSpace(1), borderRadius: webSpace(1), backgroundColor: palette.muted30 }} />
                <Text variant="muted" selectable style={[TURN_TYPE.xs, { flex: 1, fontFamily: monoFont, color: palette.mutedForeground }]}>
                  {section.text}
                </Text>
              </View>
            );

          case 'plain':
            return (
              <Text
                key={key}
                variant="muted"
                selectable
                style={[mono, { paddingHorizontal: webSpace(2.5), paddingVertical: webSpace(1), color: palette.foreground70 }]}
              >
                {section.text}
              </Text>
            );

          default:
            return null;
        }
      })}
    </View>
  );
}
