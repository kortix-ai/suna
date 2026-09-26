/**
 * SessionRetryDisplay — the gateway is retrying the turn.
 *
 * Mirrors apps/web `features/session/session-error-banner.tsx`
 * `SessionRetryDisplay`: the shared error row with no status tile (a retry is
 * not a verdict), a spinner, then three registers — title "Retrying in Ns" /
 * "Retrying now" (tabular), the gateway's reason, and "Attempt N · provider ·
 * code · request" — with the failure chain folded beneath.
 *
 * Web draws its `Loading variant="spokes"` spinner. Mobile's loading rule
 * (apps/mobile/AGENTS.md → Loading) allows only `KortixLoader` or `Skeleton`,
 * so the spinner is `KortixLoader` at the same `size-4`.
 *
 * `useRetrySecondsLeft` ticks the countdown once a second (web
 * session-chat.tsx), so "Retrying in 7s" counts down live.
 */

import { memo, useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { GatewayErrorDetails, RetryInfo } from '@kortix/sdk';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { TURN_SPACE } from '@/components/session/tool/shared/styles';
import {
  ErrorRow,
  GatewayAttemptFailureList,
  GatewayMetaLine,
  ItemContent,
  ItemDescription,
  ItemTitle,
  itemMediaStyle,
} from '@/components/session/turn/error-row';
import { retrySecondsLeft, retryTitle } from '@/lib/session/busy-status';
import { webSpace } from '@/lib/session/user-message';

export interface SessionRetryDisplayProps {
  /** `getRetryMessage(sessionStatus)`. Empty → renders nothing. */
  message: string;
  attempt: number;
  /** `useRetrySecondsLeft(retryInfo)`. */
  secondsLeft: number;
  details?: GatewayErrorDetails;
  style?: StyleProp<ViewStyle>;
}

function SessionRetryDisplayImpl({ message, attempt, secondsLeft, details, style }: SessionRetryDisplayProps) {
  if (!message) return null;
  return (
    <ErrorRow accessibilityRole="summary" style={style}>
      <View style={itemMediaStyle(true)}>
        <KortixLoader customSize={TURN_SPACE.icon} />
      </View>
      <ItemContent gap={webSpace(1)}>
        <ItemTitle tabular>{retryTitle(secondsLeft)}</ItemTitle>
        <ItemDescription>{message}</ItemDescription>
        <GatewayMetaLine leading={`Attempt ${attempt}`} details={details} />
        <GatewayAttemptFailureList details={details} />
      </ItemContent>
    </ErrorRow>
  );
}

export const SessionRetryDisplay = memo(SessionRetryDisplayImpl);
SessionRetryDisplay.displayName = 'SessionRetryDisplay';

/** Whole seconds until the scheduled retry, re-read every second. 0 without a retry. */
export function useRetrySecondsLeft(retryInfo: Pick<RetryInfo, 'next'> | null | undefined): number {
  const next = retryInfo?.next;
  const [secondsLeft, setSecondsLeft] = useState(() => (next === undefined ? 0 : retrySecondsLeft(next, Date.now())));
  useEffect(() => {
    if (next === undefined) {
      setSecondsLeft(0);
      return;
    }
    const update = () => setSecondsLeft(retrySecondsLeft(next, Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [next]);
  return secondsLeft;
}
