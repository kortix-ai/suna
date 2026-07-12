'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getMeetVoices,
  previewMeetVoice,
  setMeetBotName,
  setMeetVoice,
  type MeetVoice,
  type MeetVoicesResponse,
} from '@kortix/sdk/projects-client';

export type { MeetVoice, MeetVoicesResponse };

const key = (projectId: string | null) =>
  ['channels', 'meet-voices', projectId ?? 'none'] as const;

export function useMeetVoices(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: () => (projectId ? getMeetVoices(projectId) : null),
  });
}

export function useSetMeetVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, voice }: { projectId: string; voice: string }) =>
      setMeetVoice(projectId, voice),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useSetMeetBotName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      setMeetBotName(projectId, name),
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export async function fetchMeetVoicePreview(
  projectId: string,
  voiceId: string,
): Promise<string | null> {
  return previewMeetVoice(projectId, voiceId);
}
