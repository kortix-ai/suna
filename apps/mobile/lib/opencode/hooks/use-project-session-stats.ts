/**
 * useProjectSessionStats — fetch step-finish stats for each session in a
 * project and aggregate into project totals (messages, tokens, cost).
 *
 * Mirrors web's `fetchSessionStats` + `sumStats` from
 * apps/web/src/app/(dashboard)/projects/[id]/page.tsx so the mobile project
 * sessions tab can show the same PROJECT TOTALS card.
 */

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getAuthToken } from '@/api/config';
import { COST_MARKUP } from '@/lib/opencode/turns';
import type { MessageWithParts } from '@/lib/opencode/types';

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

async function fetchSessionStats(sandboxUrl: string, sessionId: string): Promise<SessionStats> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/session/${sessionId}/message`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch session stats: ${res.status}`);
  const data = (await res.json()) as MessageWithParts[];

  let cost = 0,
    input = 0,
    output = 0,
    reasoning = 0,
    cacheRead = 0,
    cacheWrite = 0;
  let lastUpdated: number | null = null;

  for (const item of data ?? []) {
    // MessageWithParts has { info: Message, parts: Part[] } — no casts needed.
    // Message.time has { created, completed? } — no `updated` field; use completed
    // as the best proxy for last-activity, falling back to created.
    const ts = item.info.time.completed ?? item.info.time.created;
    if (typeof ts === 'number' && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts;
    for (const p of item.parts) {
      if (p?.type === 'step-finish') {
        cost += p.cost || 0;
        input += p.tokens?.input || 0;
        output += p.tokens?.output || 0;
        reasoning += p.tokens?.reasoning || 0;
        cacheRead += p.tokens?.cache?.read || 0;
        cacheWrite += p.tokens?.cache?.write || 0;
      }
    }
  }

  return {
    messageCount: data?.length ?? 0,
    cost: cost * COST_MARKUP,
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

export function useProjectSessionStats(
  sandboxUrl: string | undefined,
  sessionIds: string[],
  enabled: boolean = true,
) {
  // N separate queries (one per session) are unavoidable here: the OpenCode
  // sandbox API exposes only per-session message endpoints
  // (`GET /session/:id/message`) — there is no bulk endpoint that returns
  // messages for multiple sessions in one call. The `staleTime: 30s` and
  // `refetchInterval: 60s` settings limit the impact so stats are fetched
  // at most once per minute per session while this hook is mounted.
  const queries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ['kortix-session-stats', sandboxUrl, id],
      queryFn: () => fetchSessionStats(sandboxUrl as string, id),
      enabled: enabled && !!sandboxUrl && !!id,
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
