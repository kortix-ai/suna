/**
 * Compaction, as one divider — the pill between two rules IS the whole turn.
 *
 * Mirrors apps/web `features/session/turn/compaction-card.tsx`:
 * 1. running → rule ── [spinner "Compacting context…" shimmer] ── rule;
 * 2. landed → rule ── [stack "Context automatically compacted" caret] ── rule.
 *    With a summary the pill is a button: `onOpenSummary` opens it elsewhere
 *    (right caret); without that handler the summary expands inline under the
 *    pill (down caret that turns 180°), collapsed until asked for;
 * 3. failed → `CompactionFailedRow`, one slim checkpoint row that replaces the
 *    turn's whole render, including its error card.
 *
 * Values: row `my-3 flex items-center gap-2 py-4`, rules `bg-border h-px
 * flex-1`, pill `bg-muted/80 gap-2 rounded-md px-3 py-1.5`, label `text-xs
 * tracking-wide text-muted-foreground`, icons `size-3.5` / carets `size-3
 * text-muted-foreground/70`, pressed `bg-accent` + `scale(0.96)`.
 *
 * Deviations, both forced by mobile rules: the spinner is `KortixLoader` (web
 * `Loading variant="spokes"`), and the stack glyph uses the app weight (web
 * duotone weight; only the fill weight may be passed).
 *
 * Which turn is a compaction, and whether it is running, is the SDK's
 * `compactionTurnInfo(turn)` — the same helper web calls.
 */

import { memo, useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { usePressScale } from '@/components/session/use-press-scale';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { TextPartBlock } from '@/components/session/turn/text-part';
import { CaretDownIcon, CaretRightIcon, StackIcon } from '@/lib/icons';
import {
  COMPACTION_LABEL_DONE,
  COMPACTION_LABEL_LOADING,
  compactionFailedLabel,
} from '@/lib/session/turn-error';
import { webSpace } from '@/lib/session/user-message';
import { MOTION, THEME, withAlpha } from '@/lib/utils/theme';

/** `text-xs tracking-wide` (0.025em). */
const PILL_LABEL_TYPE = { ...TURN_TYPE.xs, letterSpacing: TURN_TYPE.xs.fontSize * 0.025 } as const;

/** `flex-1` on a `Separator`, whose own class is `shrink-0 w-full`. */
const RULE_STYLE = { flexGrow: 1, flexShrink: 1, flexBasis: 0, width: 'auto' } as const;

const PILL_BOX = {
  flexDirection: 'row',
  alignItems: 'center',
  flexShrink: 0,
  gap: webSpace(2),
  borderRadius: TURN_SPACE.radiusMd,
  paddingHorizontal: webSpace(3),
  paddingVertical: webSpace(1.5),
} as const;

export interface CompactionMarkerProps {
  /** The summarize is still producing (`working || compactionTurnInfo(turn).inFlight`). */
  running: boolean;
  /** The landed summary markdown, if any. */
  summary?: string;
  /** Open the summary elsewhere. Absent → the pill expands the summary inline. */
  onOpenSummary?: () => void;
}

function CompactionMarkerImpl({ running, summary, onOpenSummary }: CompactionMarkerProps) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const [open, setOpen] = useState(false);
  const hasSummary = !running && Boolean(summary?.trim());
  const opensDetail = hasSummary && Boolean(onOpenSummary);
  const pillBackground = withAlpha(palette.muted, 0.8);

  const rule = <Separator style={RULE_STYLE} />;
  const glyph = <StackIcon size={webSpace(3.5)} color={palette.mutedForeground} />;
  const label = (
    <Text variant="muted" style={PILL_LABEL_TYPE}>
      {COMPACTION_LABEL_DONE}
    </Text>
  );

  return (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: webSpace(2),
          marginVertical: webSpace(3),
          paddingVertical: webSpace(4),
        }}
      >
        {rule}
        {running ? (
          <View style={[PILL_BOX, { backgroundColor: pillBackground }]}>
            <KortixLoader customSize={webSpace(3.5)} />
            <TextShimmer variant="muted" style={PILL_LABEL_TYPE}>
              {COMPACTION_LABEL_LOADING}
            </TextShimmer>
          </View>
        ) : hasSummary ? (
          <SummaryPill
            background={pillBackground}
            pressedBackground={(colorScheme === 'dark' ? THEME.dark : THEME.light).accent}
            opensDetail={opensDetail}
            open={open}
            onPress={() => {
              if (onOpenSummary) {
                onOpenSummary();
                return;
              }
              setOpen((value) => !value);
            }}
          >
            {glyph}
            {label}
          </SummaryPill>
        ) : (
          <View style={[PILL_BOX, { backgroundColor: pillBackground }]}>
            {glyph}
            {label}
          </View>
        )}
        {rule}
      </View>
      {open && hasSummary && !opensDetail ? (
        <View style={{ paddingBottom: webSpace(2) }}>
          <CompactionSummaryBody summary={summary!} />
        </View>
      ) : null}
    </View>
  );
}

function SummaryPill({
  background,
  pressedBackground,
  opensDetail,
  open,
  onPress,
  children,
}: {
  background: string;
  /** Web `hover:bg-accent`; touch has no hover, so it shows while pressed. */
  pressedBackground: string;
  opensDetail: boolean;
  open: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const palette = useTurnPalette();
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.96);
  const caretTurn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    // `transition-transform`: 150ms cubic-bezier(0.4, 0, 0.2, 1).
    caretTurn.value = withTiming(open ? 1 : 0, {
      duration: MOTION.duration.normal,
      easing: Easing.bezier(...MOTION.easing.inOut),
    });
  }, [caretTurn, open]);
  const caretStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${caretTurn.value * 180}deg` }] }));

  return (
    <Animated.View style={animatedStyle}>
      <PressableSurface
        accessibilityRole="button"
        accessibilityLabel={
          opensDetail ? 'Open compaction summary' : open ? 'Hide compaction summary' : 'Show compaction summary'
        }
        accessibilityState={opensDetail ? undefined : { expanded: open }}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        hitSlop={4}
        style={({ pressed }) => [PILL_BOX, { backgroundColor: pressed ? pressedBackground : background }]}
      >
        {children}
        {opensDetail ? (
          // A right caret: the summary opens ELSEWHERE, like a row that navigates.
          <CaretRightIcon size={webSpace(3)} color={palette.muted70} />
        ) : (
          <Animated.View style={caretStyle}>
            <CaretDownIcon size={webSpace(3)} color={palette.muted70} />
          </Animated.View>
        )}
      </PressableSurface>
    </Animated.View>
  );
}

/** Primitive props, so per-token `summary` growth while running re-renders nothing visible. */
export const CompactionMarker = memo(CompactionMarkerImpl);
CompactionMarker.displayName = 'CompactionMarker';

/** The summary prose (web `CompactionSummaryBody`: `p-6 text-sm` markdown). */
export function CompactionSummaryBody({ summary }: { summary: string }) {
  const { colorScheme } = useColorScheme();
  return (
    <View style={{ padding: webSpace(6) }}>
      <TextPartBlock text={summary} isDark={colorScheme === 'dark'} />
    </View>
  );
}

export interface CompactionFailedRowProps {
  /** The turn's error text (`getTurnError`, else `unwrapError(compactionTurnInfo(turn).error)`). */
  error?: string | null;
  /** The attempt was stopped rather than failed. */
  isAbort?: boolean;
}

/**
 * An attempt that produced no summary — errored, or stopped before the first
 * token. Web `Checkpoint`: `text-muted-foreground flex items-center gap-0.5`,
 * a `size-4` stack glyph, a `text-sm font-medium leading-none` label (`px-1`,
 * truncating) with ` · {error}` in `text-muted-foreground/70 font-normal`, and
 * a rule filling the rest of the line.
 */
function CompactionFailedRowImpl({ error, isAbort }: CompactionFailedRowProps) {
  const palette = useTurnPalette();
  const label = compactionFailedLabel({ error, isAbort });
  const detail = !isAbort && error ? error : null;
  return (
    <View
      accessibilityLabel={detail ? `${label} · ${detail}` : label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(0.5), overflow: 'hidden' }}
    >
      <StackIcon size={TURN_SPACE.icon} color={palette.mutedForeground} />
      <Text
        variant="small"
        numberOfLines={1}
        style={{ flexShrink: 1, paddingHorizontal: webSpace(1), color: palette.mutedForeground }}
      >
        {label}
        {detail ? (
          <Text variant="muted" style={{ fontSize: 14, color: palette.muted70 }}>
            {` · ${detail}`}
          </Text>
        ) : null}
      </Text>
      <Separator style={RULE_STYLE} />
    </View>
  );
}

export const CompactionFailedRow = memo(CompactionFailedRowImpl);
CompactionFailedRow.displayName = 'CompactionFailedRow';
