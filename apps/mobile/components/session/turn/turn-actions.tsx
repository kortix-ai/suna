/**
 * TurnActions — the action bar under a finished assistant turn: Copy and the
 * ⋯ turn details.
 *
 * Mirrors apps/web `session-chat.tsx` (the `!working` action bar):
 * - `flex items-center gap-0.5`, always visible on a phone (web
 *   `max-md:opacity-100`: hover-to-reveal is a desktop affordance).
 * - Copy is a ghost icon button. On copy the glyph swaps to a check with a
 *   spring (0.3s, no bounce): the outgoing glyph scales to 0.25 and fades, the
 *   incoming one scales from 0.25 and fades in. Web also blurs 4px → 0; React
 *   Native views have no CSS blur, so mobile animates opacity + scale only.
 *   The check reverts after 2s.
 * - Copy renders only when there is a response to copy; the details button
 *   hides itself when the turn has no rows.
 */

import * as React from 'react';
import { View } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { useColorScheme } from 'nativewind';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CheckIcon, CopyIcon } from '@/lib/icons';
import type { Turn } from '@/lib/opencode/types';
import { turnDurationMs, turnEndedAt, type TurnMetaCost } from '@/lib/session/turn-meta';
import { THEME } from '@/lib/utils/theme';

import { SessionTurnMeta, TURN_ACTION_ICON_SIZE } from './session-turn-meta';

/** How long the check stays before it swaps back to Copy (web: 2000ms). */
const COPIED_MS = 2000;
/** Web: `{ type: 'spring', duration: 0.3, bounce: 0 }`. */
const SWAP_SPRING = { duration: 300, dampingRatio: 1 } as const;
/** Web: `scale: 0.25` at the hidden end of the swap. */
const HIDDEN_SCALE = 0.25;

export interface TurnActionsProps {
  /** The response text Copy writes to the clipboard. Empty → no Copy button. */
  response: string;
  /**
   * The turn. When given, the details sheet derives Finished and Duration
   * exactly like web (`sessionTurnEndedAt` / `sessionTurnDurationMs`).
   */
  turn?: Turn;
  /** Finished stamp when `turn` is not given. */
  endedAt?: number | null;
  /** Duration when `turn` is not given. */
  durationMs?: number | null;
  /** @deprecated Legacy name for `durationMs`. */
  duration?: number;
  costInfo?: TurnMetaCost;
  /** @deprecated Colours come from the colour scheme. Accepted for existing callers. */
  isDark?: boolean;
  /** @deprecated Spacing belongs to the turn layout. Accepted for existing callers. */
  tightToResponse?: boolean;
  /** @deprecated The bar is always visible on a phone, with no enter fade. */
  animateIn?: boolean;
}

export function TurnActions({
  response,
  turn,
  endedAt,
  durationMs,
  duration,
  costInfo,
}: TurnActionsProps) {
  const resolvedEndedAt = React.useMemo(
    () => (turn ? turnEndedAt(turn) : (endedAt ?? null)),
    [turn, endedAt],
  );
  const resolvedDurationMs = React.useMemo(
    () => (turn ? turnDurationMs(turn) : (durationMs ?? duration ?? null)),
    [turn, durationMs, duration],
  );

  return (
    // `-ml-2 -my-1.5`: the buttons keep their 40pt touch target, and the glyph
    // lands where web's 26px button puts it (≈4px in from the text edge).
    <View className="-my-1.5 -ml-2 flex-row items-center gap-0.5" testID="session-turn-actions">
      {response ? <CopyResponseButton response={response} /> : null}
      <SessionTurnMeta endedAt={resolvedEndedAt} durationMs={resolvedDurationMs} cost={costInfo} />
    </View>
  );
}

function CopyResponseButton({ response }: { response: string }) {
  const { colorScheme } = useColorScheme();
  const color = THEME[colorScheme === 'dark' ? 'dark' : 'light'].mutedForeground;
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // 0 = Copy showing, 1 = Check showing. Starts settled: web `initial={false}`.
  const progress = useSharedValue(0);

  React.useEffect(() => {
    progress.value = withSpring(copied ? 1 : 0, SWAP_SPRING);
  }, [copied, progress]);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = React.useCallback(async () => {
    await Clipboard.setStringAsync(response);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [response]);

  const copyStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 - (1 - HIDDEN_SCALE) * progress.value }],
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: HIDDEN_SCALE + (1 - HIDDEN_SCALE) * progress.value }],
  }));

  return (
    <Button
      variant="ghost"
      size="icon"
      onPress={handleCopy}
      accessibilityLabel={copied ? 'Copied' : 'Copy response'}
      testID="session-turn-copy">
      <View style={{ width: TURN_ACTION_ICON_SIZE, height: TURN_ACTION_ICON_SIZE }}>
        <Reanimated.View style={[ABSOLUTE_CENTER, copyStyle]}>
          <Icon as={CopyIcon} size={TURN_ACTION_ICON_SIZE} color={color} />
        </Reanimated.View>
        <Reanimated.View style={[ABSOLUTE_CENTER, checkStyle]}>
          <Icon as={CheckIcon} size={TURN_ACTION_ICON_SIZE} color={color} />
        </Reanimated.View>
      </View>
    </Button>
  );
}

const ABSOLUTE_CENTER = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
