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
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowClockwiseIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';
import { useOnlineStatus } from '@/lib/network/use-online-status';
import { THEME } from '@/lib/utils/theme';

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

  // The composer card, exactly (components/kortix/composer.tsx), as in
  // `SandboxHealthPill`: `px-4` edge, `rounded-3xl border border-border
  // bg-background p-2`, the composer's `secondary` `sm` pill for the action.
  return (
    <View className="px-4 pb-2" accessibilityLiveRegion="polite">
      <View className="flex-row items-center gap-2 rounded-3xl border border-border bg-background p-2">
        <View className="flex-1 flex-row items-center gap-2 px-2">
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: THEME.accent.orange }} />
          <Text variant="muted" className="shrink" numberOfLines={1}>
            Live updates paused
          </Text>
        </View>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          accessibilityLabel="Reconnect live updates"
          onPress={handleReconnect}>
          <Icon as={ArrowClockwiseIcon} size={14} />
          <Text>Reconnect</Text>
        </Button>
      </View>
    </View>
  );
}
