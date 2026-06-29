'use client';

import { backendApi } from '@/lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface MeetVoice {
  id: string;
  name: string;
  desc: string;
}

export interface MeetVoicesResponse {
  selected: string;
  bot_name: string;
  default_bot_name: string;
  speak_enabled: boolean;
  voices: MeetVoice[];
}

const key = (projectId: string | null) =>
  ['channels', 'meet-voices', projectId ?? 'none'] as const;

export function useMeetVoices(projectId: string | null) {
  return useQuery({
    queryKey: key(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!projectId) return null;
      const res = await backendApi.get<MeetVoicesResponse>(
        `/projects/${encodeURIComponent(projectId)}/channels/meet/voices`,
        { showErrors: false },
      );
      if (!res.success) return null;
      return res.data ?? null;
    },
  });
}

export function useSetMeetVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, voice }: { projectId: string; voice: string }) => {
      const res = await backendApi.put<{ selected: string }>(
        `/projects/${encodeURIComponent(projectId)}/channels/meet/voice`,
        { voice },
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to save voice');
      }
      return res.data;
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export function useSetMeetBotName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, name }: { projectId: string; name: string }) => {
      const res = await backendApi.put<{ bot_name: string }>(
        `/projects/${encodeURIComponent(projectId)}/channels/meet/name`,
        { name },
        { showErrors: false },
      );
      if (!res.success || !res.data) {
        throw new Error(res.error?.message ?? 'Failed to save name');
      }
      return res.data;
    },
    onSuccess: (_data, { projectId }) => {
      qc.invalidateQueries({ queryKey: key(projectId) });
    },
  });
}

export async function fetchMeetVoicePreview(
  projectId: string,
  voiceId: string,
): Promise<string | null> {
  const res = await backendApi.post<{ b64: string }>(
    `/projects/${encodeURIComponent(projectId)}/channels/meet/voices/${encodeURIComponent(voiceId)}/preview`,
    {},
    { showErrors: false },
  );
  if (!res.success || !res.data?.b64) return null;
  return res.data.b64;
}
