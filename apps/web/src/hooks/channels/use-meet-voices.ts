'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  channelAction,
  type MeetVoice,
  type MeetVoicesResponse,
} from '@kortix/sdk/projects-client';

export type { MeetVoice, MeetVoicesResponse };

// Meet is a connector channel now — voice config + speaking are runtime
// capabilities reached through the generic `channelAction` dispatch. These
// hooks keep their existing shape.
const key = (projectId: string | null) =>
  ['channels', 'meet-voices', projectId ?? 'none'] as const;

export function useMeetVoices(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!projectId) return null;
      try {
        return await channelAction<MeetVoicesResponse>(projectId, 'meet', 'voices', undefined, 'get');
      } catch {
        return null;
      }
    },
  });
}

export function useSetMeetVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, voice }: { projectId: string; voice: string }) =>
      channelAction<{ selected: string }>(projectId, 'meet', 'setVoice', { voice }, 'put'),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useSetMeetBotName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      channelAction<{ bot_name: string }>(projectId, 'meet', 'setName', { name }, 'put'),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export async function fetchMeetVoicePreview(
  projectId: string,
  voiceId: string,
): Promise<string | null> {
  try {
    // voiceId now travels in the body (the generic actions route has no path param).
    const res = await channelAction<{ b64: string }>(
      projectId,
      'meet',
      'previewVoice',
      { voiceId },
      'post',
    );
    return res.b64 ?? null;
  } catch {
    return null;
  }
}
