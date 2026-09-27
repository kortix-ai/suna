/**
 * SessionBusyIndicator — the working row under a live turn.
 *
 * Mirrors apps/web `features/session/session-busy-indicator.tsx`:
 * - row `flex w-full min-w-0 items-center gap-1.5 py-0.5 text-xs text-muted-foreground`;
 * - a 14px `SessionDotMatrix` keyed by the session id;
 * - the label `text-sm leading-5`, shimmering: "Thinking", then the live status;
 * - a label change rolls in — new label from `translateY(100%)`, old label out
 *   to `translateY(-100%)`, both with a 0.4s bounce-free spring; Reduce Motion
 *   → a 0.2s ease-out cross-fade;
 * - `elapsedLabel` in its own non-animated `text-muted-foreground/70
 *   tabular-nums` text, so a ticking clock never replays the roll;
 * - `retryLabel` replaces the shimmer with a static muted/70 line.
 *
 * `useTurnBusyStatus` and `useRetrySecondsLeft` (session-retry-display.tsx)
 * are web session-chat.tsx's status throttle, stall clock, and countdown.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  withSpring,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { getTurnStatus, type PartLike } from '@kortix/sdk';

import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Text } from '@/components/ui/text';
import { SessionDotMatrix } from '@/components/session/dot-matrix/session-dot-matrix';
import { useReduceMotion } from '@/components/session/dot-matrix/use-reduce-motion';
import { TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import {
  BUSY_DEFAULT_STATUS,
  busyStatusLabels,
  statusElapsedFrame,
  statusThrottleDecision,
} from '@/lib/session/busy-status';
import { webSpace } from '@/lib/session/user-message';
import { MOTION } from '@/lib/utils/theme';

/** `leading-5` — the roll distance is one line box (web `translateY(±100%)`). */
const LINE = TURN_TYPE.sm.lineHeight;
/** motion `{ type: 'spring', duration: 0.4, bounce: 0 }`. */
const ROLL_SPRING = { duration: 400, dampingRatio: 1 } as const;
/** motion `{ duration: 0.2, ease: 'easeOut' }` — `easeOut` is cubic-bezier(0, 0, 0.58, 1). */
const FADE_EASING = Easing.bezier(0, 0, 0.58, 1);
const FADE_IN = FadeIn.duration(MOTION.duration.moderate).easing(FADE_EASING);
const FADE_OUT = FadeOut.duration(MOTION.duration.moderate).easing(FADE_EASING);

/** `initial: translateY(100%), opacity 0` → `animate: translateY(0%), opacity 1`. */
const rollIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: LINE }] },
    animations: {
      opacity: withSpring(1, ROLL_SPRING),
      transform: [{ translateY: withSpring(0, ROLL_SPRING) }],
    },
  };
};

/** `exit: translateY(-100%), opacity 0`. */
const rollOut: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withSpring(0, ROLL_SPRING),
      transform: [{ translateY: withSpring(-LINE, ROLL_SPRING) }],
    },
  };
};

export interface SessionBusyIndicatorProps {
  /** The live status phrase. Empty → "Thinking". */
  statusText?: string;
  /** Time on the current status, e.g. "24s". Never fold it into `statusText`. */
  elapsedLabel?: string;
  /** Set while a retry is scheduled ("Waiting to retry"); replaces the shimmer. */
  retryLabel?: string;
  /** Keys the dot-matrix glyph. */
  sessionId?: string;
  style?: StyleProp<ViewStyle>;
}

function SessionBusyIndicatorImpl({ statusText, elapsedLabel, retryLabel, sessionId, style }: SessionBusyIndicatorProps) {
  const palette = useTurnPalette();
  const reduceMotion = useReduceMotion();
  const retryText = retryLabel?.trim();
  const status = statusText?.trim();
  const elapsed = elapsedLabel?.trim();
  const label = retryText || status || BUSY_DEFAULT_STATUS;
  const mutedLine = [TURN_TYPE.sm, { color: palette.muted70, fontVariant: ['tabular-nums' as const] }];

  return (
    <View
      testID="session-busy-indicator"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'stretch',
          minWidth: 0,
          gap: webSpace(1.5),
          paddingVertical: webSpace(0.5),
        },
        style,
      ]}
    >
      <SessionDotMatrix sessionId={sessionId} size={14} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {retryText ? (
          <Text variant="muted" numberOfLines={1} style={mutedLine}>
            {label}
          </Text>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: webSpace(1.5) }}>
            <RollingLabel label={label} reduceMotion={reduceMotion} />
            {elapsed ? (
              <Text variant="muted" style={[mutedLine, { flexShrink: 0 }]}>
                {elapsed}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Web `AnimatePresence initial={false} mode="popLayout"` around the shimmer,
 * keyed by the label: the first label renders in place (`skipEntering`); each
 * change mounts the new label with the roll-in and unmounts the old one with
 * the roll-out, taken out of layout while it leaves.
 */
function RollingLabel({ label, reduceMotion }: { label: string; reduceMotion: boolean }) {
  return (
    <View style={{ flex: 1, minWidth: 0, height: LINE, overflow: 'hidden' }}>
      <LayoutAnimationConfig skipEntering>
        <Animated.View
          key={label}
          entering={reduceMotion ? FADE_IN : rollIn}
          exiting={reduceMotion ? FADE_OUT : rollOut}
        >
          <TextShimmer variant="muted" style={TURN_TYPE.sm} numberOfLines={1}>
            {label}
          </TextShimmer>
        </Animated.View>
      </LayoutAnimationConfig>
    </View>
  );
}

export const SessionBusyIndicator = memo(SessionBusyIndicatorImpl);
SessionBusyIndicator.displayName = 'SessionBusyIndicator';

/**
 * Web session-chat.tsx's busy status for one turn:
 * - `getTurnStatus` only once the turn has an assistant message (before that
 *   the row keeps "Thinking" — the fallback phrase would claim work that has
 *   not started);
 * - a new status applies at most once per 2.5s, measured from mount;
 * - after 20s on one status, `elapsedLabel` carries the time and the phrase
 *   drops its trailing ellipsis.
 *
 * Pass the result straight to `SessionBusyIndicator`.
 */
export function useTurnBusyStatus({
  allParts,
  working,
  hasAssistantContent,
}: {
  allParts: ReadonlyArray<{ part: PartLike }>;
  working: boolean;
  hasAssistantContent: boolean;
}): { statusText: string | undefined; elapsedLabel: string | undefined } {
  const rawStatus = useMemo(
    () => (hasAssistantContent ? getTurnStatus(allParts) : ''),
    [allParts, hasAssistantContent],
  );
  const [mountedAt] = useState(() => Date.now());
  const lastChangeRef = useRef(mountedAt);
  const allPartsRef = useRef(allParts);
  allPartsRef.current = allParts;
  const [throttledStatus, setThrottledStatus] = useState('');

  useEffect(() => {
    const decision = statusThrottleDecision({
      rawStatus,
      throttledStatus,
      lastChangeAtMs: lastChangeRef.current,
      nowMs: Date.now(),
    });
    if (decision.type === 'keep') return;
    if (decision.type === 'apply') {
      setThrottledStatus(rawStatus);
      lastChangeRef.current = Date.now();
      return;
    }
    const timer = setTimeout(() => {
      setThrottledStatus(getTurnStatus(allPartsRef.current));
      lastChangeRef.current = Date.now();
    }, decision.delayMs);
    return () => clearTimeout(timer);
  }, [allParts, rawStatus, throttledStatus]);

  const [elapsedState, setElapsedState] = useState(() =>
    statusElapsedFrame(undefined, { status: throttledStatus, working, nowMs: Date.now() }),
  );
  useEffect(() => {
    const update = () =>
      setElapsedState((previous) =>
        statusElapsedFrame(previous, { status: throttledStatus, working, nowMs: Date.now() }),
      );
    update();
    if (!working) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [working, throttledStatus]);

  const elapsedMs =
    elapsedState.status === throttledStatus && elapsedState.working === working ? elapsedState.elapsedMs : 0;
  const { phrase, elapsedLabel } = busyStatusLabels({ throttledStatus, working, elapsedMs });
  return { statusText: phrase || undefined, elapsedLabel };
}
