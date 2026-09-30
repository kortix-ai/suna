/**
 * LiveUpdatesPausedPill — "Live updates paused · Reconnect" (COR-144). A bar
 * directly above the chat input, drawn as the composer card, the same look and
 * slot as `SandboxHealthPill`. `SessionPage` shows it when the thread's live
 * stream stopped (gave up, a 401/403, or no connection for
 * `STREAM_STALLED_MS`) and the sandbox itself is reachable; an unreachable
 * sandbox shows `SandboxHealthPill` instead. Hidden while offline: the global
 * "No internet connection" banner already says why.
 *
 * Reconnect restarts the stream at once (`useStreamHealthStore.reconnect` →
 * `event-stream.ts` `retryNow`), past any backoff or park.
 */

import * as React from 'react';

import { ArrowClockwiseIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';
import { useOnlineStatus } from '@/lib/network/use-online-status';
import { THEME } from '@/lib/utils/theme';
import { ComposerStatusAction, ComposerStatusPill } from './ComposerStatusPill';

interface LiveUpdatesPausedPillProps {
  onReconnect: () => void;
}

export function LiveUpdatesPausedPill({ onReconnect }: LiveUpdatesPausedPillProps) {
  const online = useOnlineStatus();
  if (!online) return null;

  const handleReconnect = () => {
    haptics.tap();
    onReconnect();
  };

  return (
    <ComposerStatusPill
      accessibilityLiveRegion="polite"
      dotColor={THEME.accent.orange}
      label="Live updates paused"
      actions={
        <ComposerStatusAction
          icon={ArrowClockwiseIcon}
          label="Reconnect"
          accessibilityLabel="Reconnect live updates"
          onPress={handleReconnect}
        />
      }
    />
  );
}
