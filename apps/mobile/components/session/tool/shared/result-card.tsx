/**
 * The card a tool's result list lives in — web sources, matched files, grep
 * hits, patched files.
 *
 * Mirrors apps/web `tool/shared/result-card.tsx`:
 * - frame `p-1` (a scrollbar gutter that cannot scroll), `rounded-md border`,
 *   `border-border bg-popover`, or `border-destructive/40 bg-destructive/10`
 *   for `tone="destructive"`;
 * - `mt-1.5` seam + the shared tool indent (inline surface only);
 * - body capped at `max-h-96` and scrollable; the rows' own inset is the
 *   caller's `bodyStyle` (web `bodyClassName`).
 *
 * On the panel surface the neutral frame drops (the row card is the frame);
 * the destructive tint keeps its edge on both surfaces.
 */

import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { TURN_SPACE, useTurnPalette } from './styles';
import { useToolCardFrame, useToolIndent, ToolScroll } from './surface';

export function ToolResultCard({
  children,
  style,
  bodyStyle,
  tone = 'default',
}: {
  children: ReactNode;
  /** Web `className` on the frame. */
  style?: StyleProp<ViewStyle>;
  /** Web `bodyClassName` on the scroll body. */
  bodyStyle?: StyleProp<ViewStyle>;
  /** `destructive` tints the card for failures. Opt in per call site. */
  tone?: 'default' | 'destructive';
}) {
  const palette = useTurnPalette();
  const indent = useToolIndent();
  const frame = useToolCardFrame();
  const framed = tone === 'destructive' || frame !== null;

  return (
    <View
      style={[
        { padding: TURN_SPACE.resultFramePad, overflow: 'hidden' },
        framed && {
          borderWidth: 1,
          borderRadius: TURN_SPACE.radiusMd,
          borderColor: tone === 'destructive' ? palette.destructive40 : palette.border,
          backgroundColor: tone === 'destructive' ? palette.destructive10 : palette.popover,
        },
        indent ? { marginTop: TURN_SPACE.gap1_5, marginLeft: indent } : null,
        style,
      ]}
    >
      <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight} contentContainerStyle={bodyStyle} showsVerticalScrollIndicator>
        {children}
      </ToolScroll>
    </View>
  );
}
