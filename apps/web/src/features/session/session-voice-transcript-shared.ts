'use client';

/**
 * Shared data for the per-session "Voice" transcript surface — every spoken
 * turn (role 'user'/'agent', from `kortix.voice_call_turns`) plus every
 * ask_kortix/run_command the voice-agent worker issued through the voice MCP
 * (role 'tool' — see apps/api/src/channels/voice/mcp.ts's `callTool`).
 *
 * A call's `callId` IS its `sessionId` (see apps/api/src/channels/voice/
 * runtime.ts's file header), so there is nothing else to key this by.
 *
 * Modeled on `session-audit-shared.tsx`'s `useSessionAudit`: one react-query
 * key, poll-and-replace (not an incremental accumulate-by-cursor client) —
 * a call's turn count is small enough that refetching the whole thing each
 * poll is simpler and just as correct. The `cursor` field the endpoint
 * returns exists for a true incremental consumer (the voice agent's own
 * poll loop); this UI doesn't need it.
 */

import { type VoiceTranscript, getVoiceTranscript } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

/** Faster than the audit trail's 15s: this is a LIVE spoken conversation, not
 *  an approvals inbox — a caller waiting on the transcript to catch up reads
 *  as broken far sooner than an approval taking 15s to show up does. */
export const VOICE_TRANSCRIPT_REFETCH_MS = 2_500;

/** Turns beyond this per poll would need real cursor-based paging (not
 *  built here) — comfortably above what a single call produces. */
const TRANSCRIPT_LIMIT = 500;

export function voiceTranscriptKey(projectId: string | undefined, sessionId: string | undefined) {
  return ['voice-transcript', projectId ?? '', sessionId ?? ''] as const;
}

interface UseVoiceTranscriptOptions {
  /** Skip the query entirely (e.g. not the active session / missing ids). */
  enabled?: boolean;
  /** Poll cadence in ms. Default 2.5s; pass `false` to poll once. */
  refetchInterval?: number | false;
  /** Suppress the global error toast (for an ambient/background mount). */
  silent?: boolean;
}

export function useVoiceTranscript(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: UseVoiceTranscriptOptions,
) {
  const enabled = !!projectId && !!sessionId && (options?.enabled ?? true);
  return useQuery<VoiceTranscript>({
    queryKey: voiceTranscriptKey(projectId, sessionId),
    // `enabled` guards presence, so the `?? ''` fallbacks are never exercised.
    queryFn: () =>
      getVoiceTranscript(projectId ?? '', sessionId ?? '', {
        limit: TRANSCRIPT_LIMIT,
        showErrors: !options?.silent,
      }),
    enabled,
    staleTime: 2_000,
    refetchInterval: options?.refetchInterval ?? VOICE_TRANSCRIPT_REFETCH_MS,
  });
}

/** Display label for a turn's speaker column. 'tool' turns carry their own
 *  descriptive text (`ask_kortix: ...` / `run_command: ... → ok`) — the
 *  `speaker` field just names which tool, so it reads as a tag, not a name. */
export function turnSpeakerLabel(role: string, speaker: string | null): string {
  if (role === 'tool') return speaker ?? 'tool call';
  if (role === 'agent') return 'Kortix';
  return speaker ?? 'Caller';
}

export function relativeTurnTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 10_000) return 'now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
