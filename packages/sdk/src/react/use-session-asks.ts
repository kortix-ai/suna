'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  answerSessionAsk,
  listSessionAsks,
  type SessionAsk,
  type SessionAskAnswer,
  type SessionAsksResponse,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

export interface SessionNeedsYou {
  /** True while any ask waits on the viewer for this session. */
  needsYou: boolean;
  /** Its open asks, oldest first: the session's own and its hidden workers'. */
  asks: SessionAsk[];
}

const NOTHING: SessionNeedsYou = { needsYou: false, asks: [] };

/**
 * The asks a person sees on `sessionId`: those it asked itself and those its
 * hidden workers asked (`surface_session_id`), oldest first. Pure; exported for tests.
 */
export function sessionNeedsYou(asks: readonly SessionAsk[] | undefined, sessionId: string): SessionNeedsYou {
  if (!asks?.length || !sessionId) return NOTHING;
  const mine = asks
    .filter((ask) => ask.surface_session_id === sessionId || ask.session_id === sessionId)
    .sort((a, b) => (a.asked_at < b.asked_at ? -1 : a.asked_at > b.asked_at ? 1 : 0));
  return mine.length ? { needsYou: true, asks: mine } : NOTHING;
}

/** The list without a decided ask, so the next one shows before the refetch lands. Pure; exported for tests. */
export function asksAfterDecision(list: SessionAsksResponse | undefined, askId: string): SessionAsksResponse | undefined {
  if (!list) return list;
  const asks = list.asks.filter((ask) => ask.id !== askId);
  return { asks, total: asks.length };
}

/**
 * Every open ask in the project the viewer may decide: agent questions, tool
 * calls that wait for approval, connector approvals. One query per project
 * serves the Review deck, the badge and each session's "Needs you". Polled every
 * 30 s; an open session's stream refetches it on each ask event.
 */
export function useSessionAsks(projectId: string, options?: { enabled?: boolean }) {
  const enabled = Boolean(projectId) && options?.enabled !== false;
  return useQuery({
    queryKey: qk.project.asks(projectId),
    queryFn: () => listSessionAsks(projectId),
    enabled,
    ...contract('volatile'),
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

/** How many asks wait on the viewer across the project: the Review badge. */
export function useOpenAskCount(projectId: string, options?: { enabled?: boolean }): number {
  return useSessionAsks(projectId, options).data?.asks.length ?? 0;
}

/** What waits on the viewer in one session (its hidden workers included): the "Needs you" state and its cards. */
export function useSessionNeedsYou(projectId: string, sessionId: string, options?: { enabled?: boolean }): SessionNeedsYou {
  const { data } = useSessionAsks(projectId, options);
  return useMemo(() => sessionNeedsYou(data?.asks, sessionId), [data, sessionId]);
}

/**
 * Decide one ask. The ask leaves the cached list at once (the next card
 * shows), and the asks, the needs-input counts and the review summary refetch.
 * On a refusal (an ask someone else already decided) the list refetches too.
 */
export function useAnswerSessionAsk(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ askId, answer }: { askId: string; answer: SessionAskAnswer }) => answerSessionAsk(projectId, askId, answer),
    onMutate: async ({ askId }) => {
      await queryClient.cancelQueries({ queryKey: qk.project.asks(projectId) });
      const before = queryClient.getQueryData<SessionAsksResponse>(qk.project.asks(projectId));
      queryClient.setQueryData(qk.project.asks(projectId), asksAfterDecision(before, askId));
      return { before };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.project.asks(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.needsInput(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.project.reviewSummary(projectId) });
    },
  });
}
