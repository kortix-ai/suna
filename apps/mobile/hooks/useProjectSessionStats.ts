/**
 * useProjectSessionStats — token and cost totals of a project's sessions, for
 * the project detail page. Each session's whole transcript is read from the
 * bound session's runtime (`loadSessionTranscriptMessages`) and summed.
 */

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getSessionCost } from '@kortix/sdk';
import { loadSessionTranscriptMessages } from '@kortix/sdk/react';
import { useSessionRuntime } from '@/components/session/SessionRuntime';

export type SessionStats = {
  messageCount: number;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  lastUpdated: number | null;
};

const EMPTY_STATS: SessionStats = {
  messageCount: 0,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  lastUpdated: null,
};

async function fetchSessionStats(sessionId: string): Promise<SessionStats> {
  const data = await loadSessionTranscriptMessages(sessionId);

  let input = 0,
    output = 0,
    reasoning = 0,
    cacheRead = 0,
    cacheWrite = 0;
  let lastUpdated: number | null = null;

  for (const item of data) {
    const time = item.info.time as { updated?: number; completed?: number; created?: number } | undefined;
    const ts = time?.updated ?? time?.completed ?? time?.created;
    if (typeof ts === 'number' && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts;
    for (const part of item.parts) {
      if (part.type !== 'step-finish') continue;
      input += part.tokens?.input || 0;
      output += part.tokens?.output || 0;
      reasoning += part.tokens?.reasoning || 0;
      cacheRead += part.tokens?.cache?.read || 0;
      cacheWrite += part.tokens?.cache?.write || 0;
    }
  }

  return {
    messageCount: data.length,
    cost: getSessionCost(data),
    tokens: { input, output, reasoning, cacheRead, cacheWrite },
    lastUpdated,
  };
}

function sumStats(items: SessionStats[]): SessionStats {
  const acc: SessionStats = { ...EMPTY_STATS, tokens: { ...EMPTY_STATS.tokens } };
  for (const s of items) {
    acc.messageCount += s.messageCount;
    acc.cost += s.cost;
    acc.tokens.input += s.tokens.input;
    acc.tokens.output += s.tokens.output;
    acc.tokens.reasoning += s.tokens.reasoning;
    acc.tokens.cacheRead += s.tokens.cacheRead;
    acc.tokens.cacheWrite += s.tokens.cacheWrite;
    if (s.lastUpdated && (!acc.lastUpdated || s.lastUpdated > acc.lastUpdated)) {
      acc.lastUpdated = s.lastUpdated;
    }
  }
  return acc;
}

export function totalTokens(t: SessionStats['tokens']): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

export function useProjectSessionStats(sessionIds: string[], enabled: boolean = true) {
  // The runtime these sessions live on: the bound session's. Its sandbox id
  // keys the cache, so one computer's totals never show under another.
  const runtime = useSessionRuntime();
  const runtimeId = runtime?.switched ? (runtime.sandbox?.sandbox_id ?? null) : null;
  const queries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ['kortix-session-stats', runtimeId, id],
      queryFn: () => fetchSessionStats(id),
      enabled: enabled && !!runtimeId && !!id,
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });

  const totals = useMemo(() => {
    const items: SessionStats[] = [];
    for (const q of queries) if (q.data) items.push(q.data);
    return sumStats(items);
  }, [queries]);

  const loading = queries.some((q) => q.isLoading);

  return { totals, loading };
}
