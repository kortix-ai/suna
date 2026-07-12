/**
 * useProjectSessionStats — aggregate project session totals.
 *
 * ACP sessions do not expose harness-native message step-finish
 * parts. Until token/cost summaries are persisted in the project-session API,
 * mobile reports zeroed totals instead of scraping a harness-native endpoint.
 */

import { useMemo } from 'react';

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
  const totals = useMemo(() => {
    void sandboxUrl;
    void sessionIds;
    void enabled;
    return sumStats([]);
  }, [sandboxUrl, sessionIds, enabled]);

  return { totals, loading: false };
}
