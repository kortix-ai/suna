/**
 * The pieces every MyKortix agent surface is drawn from on mobile, so a
 * sub-agent call, a workflow run and an agent's finish read as one family.
 * Port of apps/web `session/agents/agent-surface.tsx` and the run ring in
 * `tool/tools/workflow-progress.tsx`:
 *
 *   AgentCard        a bordered, rounded card; one Pressable when it leads somewhere
 *   DashedRule       the dashed separator between workflow phases
 *   RunProgressRing  done (green) and failed (red) over a grey track; a check when
 *                    the run is done, a square when it was stopped. It never turns.
 */

import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { webSpace } from '@/lib/session/user-message';
import { useTurnPalette } from './styles';

/** Web `rounded-lg`. */
const CARD_RADIUS = 10;

export function AgentCard({
  children,
  onPress,
  label,
  style,
  testID,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** The card's accessible name when it is one button. */
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const palette = useTurnPalette();
  const frame: ViewStyle = {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: CARD_RADIUS,
    backgroundColor: palette.card,
    overflow: 'hidden',
  };
  if (onPress) {
    return (
      <PressableSurface
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [
          frame,
          { flexDirection: 'row', alignItems: 'center', gap: webSpace(2.5), paddingHorizontal: webSpace(3.5), minHeight: 44 },
          pressed && { backgroundColor: palette.pressed },
          style,
        ]}
      >
        {children}
      </PressableSurface>
    );
  }
  return (
    <View testID={testID} style={[frame, style]}>
      {children}
    </View>
  );
}

/** A 1pt dashed line. iOS draws a dashed border only on all four sides, so the box is clipped to its top edge. */
export function DashedRule() {
  const palette = useTurnPalette();
  return (
    <View style={{ height: 1, overflow: 'hidden' }} accessible={false}>
      <View style={{ height: 2, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.border }} />
    </View>
  );
}

const SOLID_CHECK =
  'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10s10-4.5 10-10S17.5 2 12 2zm4.2 8.3l-4.8 4.8c-.4.4-1 .4-1.4 0l-2.2-2.2c-.4-.4-.4-1 0-1.4c.4-.4 1-.4 1.4 0l1.5 1.5l4.1-4.1c.4-.4 1-.4 1.4 0c.4.4.4 1 0 1.4z';

export function RunProgressRing({
  done,
  failed,
  total,
  size = 16,
  ended,
}: {
  done: number;
  failed: number;
  total: number;
  size?: 16 | 28;
  ended?: 'done' | 'stopped' | null;
}) {
  const palette = useTurnPalette();
  const big = size === 28;
  const c = big ? 14 : 8;
  const r = big ? 11 : 6.3;
  const stroke = big ? 2.5 : 1.5;
  // Every agent finished: the solid check (web `SolidCheckIcon`, the same path), in the done hue.
  if (ended === 'done' && failed === 0) {
    return (
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        <Svg width={size} height={size} viewBox="0 0 24 24">
          <Path d={SOLID_CHECK} fill={palette.kortixGreen} />
        </Svg>
      </View>
    );
  }
  const length = 2 * Math.PI * r;
  const part = (count: number) => (total > 0 ? (count / total) * length : 0);
  // Room between two arcs and for the round caps.
  const gap = length * 0.09;
  const arc = (count: number) => Math.max(0, part(count) - (count > 0 && count < total ? gap : 0));
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${c * 2} ${c * 2}`}>
        <Circle cx={c} cy={c} r={r} stroke={palette.mutedForeground} strokeOpacity={0.35} strokeWidth={stroke} fill="none" />
        {done > 0 ? (
          <Circle
            cx={c}
            cy={c}
            r={r}
            stroke={palette.kortixGreen}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${arc(done)} ${length}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        ) : null}
        {failed > 0 ? (
          <Circle
            cx={c}
            cy={c}
            r={r}
            stroke={palette.destructive}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${arc(failed)} ${length}`}
            strokeDashoffset={-part(done)}
            transform={`rotate(-90 ${c} ${c})`}
          />
        ) : null}
        {ended === 'stopped' ? (
          <Rect
            x={c - (big ? 3 : 1.75)}
            y={c - (big ? 3 : 1.75)}
            width={big ? 6 : 3.5}
            height={big ? 6 : 3.5}
            rx={big ? 1.2 : 0.7}
            fill={palette.mutedForeground}
          />
        ) : null}
      </Svg>
    </View>
  );
}
