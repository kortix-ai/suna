'use client';

import { setMeetBotName } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';

/**
 * Voice channel settings. Only the bot's display name is configurable — the
 * speaking voice comes from the realtime provider now, not a per-workspace pick,
 * so there is no catalog to fetch or preview.
 */
export function useSetVoiceBotName() {
  return useMutation({
    mutationFn: ({ workspaceId, name }: { workspaceId: string; name: string }) =>
      setMeetBotName(workspaceId, name),
  });
}
