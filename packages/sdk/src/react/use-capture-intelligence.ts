'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import {
  askCapture,
  createCaptureExport,
  draftCaptureSkill,
  exportCaptureSkill,
  getCaptureEpisode,
  getCaptureExport,
  getCaptureOverview,
  getCaptureWorkflow,
  listCaptureEpisodes,
  listCaptureWorkflows,
  reviewCaptureWorkflow,
  type CaptureAskInput,
  type CaptureAskSource,
  type CaptureEpisodeQuery,
  type CaptureExportInput,
  type CaptureSkillExportInput,
  type CaptureWorkflowQuery,
  type CaptureWorkflowReview,
} from '../core/rest/platform-client/capture-intelligence';
import { contract, FRESHNESS } from './query-contracts';
import { qk } from './query-keys';

type Id = string | null | undefined;

/** Hours recorded, automatable hours a week, top and new workflows, trend (admins, viewers). */
export function useCaptureOverview(accountId: Id, window: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: qk.capture.overview(accountId ?? '', window),
    queryFn: () => getCaptureOverview(accountId as string, window),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureIntelligence),
  });
}

export function useCaptureWorkflows(accountId: Id, query: CaptureWorkflowQuery = {}) {
  return useQuery({
    queryKey: qk.capture.workflowList(accountId ?? '', query),
    queryFn: () => listCaptureWorkflows(accountId as string, query),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureIntelligence),
  });
}

export function useCaptureWorkflow(accountId: Id, workflowId: Id) {
  return useQuery({
    queryKey: qk.capture.workflow(accountId ?? '', workflowId ?? ''),
    queryFn: () => getCaptureWorkflow(accountId as string, workflowId as string),
    enabled: !!accountId && !!workflowId,
    ...contract(FRESHNESS.captureIntelligence),
  });
}

/** Review a workflow (Capture admins); refreshes it and the lists. */
export function useReviewCaptureWorkflow(accountId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { workflowId: string; review: CaptureWorkflowReview }) =>
      reviewCaptureWorkflow(accountId as string, args.workflowId, args.review),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.capture.workflows(accountId ?? '') }),
  });
}

/** Draft a SKILL.md from a workflow (Capture admins). Changes nothing. */
export function useDraftCaptureSkill(accountId: Id) {
  return useMutation({
    mutationFn: (args: { workflowId: string; name?: string }) =>
      draftCaptureSkill(accountId as string, args.workflowId, args.name ? { name: args.name } : {}),
  });
}

/** Publish a skill into a project (Capture admins); the workflow reads as exported. */
export function useExportCaptureSkill(accountId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { workflowId: string; input: CaptureSkillExportInput }) =>
      exportCaptureSkill(accountId as string, args.workflowId, args.input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.capture.workflows(accountId ?? '') }),
  });
}

export function useCaptureEpisodes(accountId: Id, query: CaptureEpisodeQuery = {}) {
  return useQuery({
    queryKey: qk.capture.episodes(accountId ?? '', query),
    queryFn: () => listCaptureEpisodes(accountId as string, query),
    enabled: !!accountId,
    ...contract(FRESHNESS.captureIntelligence),
  });
}

export function useCaptureEpisode(accountId: Id, episodeId: Id) {
  return useQuery({
    queryKey: qk.capture.episode(accountId ?? '', episodeId ?? ''),
    queryFn: () => getCaptureEpisode(accountId as string, episodeId as string),
    enabled: !!accountId && !!episodeId,
    ...contract(FRESHNESS.captureIntelligence),
  });
}

export function useCreateCaptureExport(accountId: Id) {
  return useMutation({ mutationFn: (input: CaptureExportInput) => createCaptureExport(accountId as string, input) });
}

/** One export; polls every `pollMs` (2 s) while it is queued or running. */
export function useCaptureExport(accountId: Id, exportId: Id, { pollMs = 2_000 }: { pollMs?: number } = {}) {
  return useQuery({
    queryKey: qk.capture.export(accountId ?? '', exportId ?? ''),
    queryFn: () => getCaptureExport(accountId as string, exportId as string),
    enabled: !!accountId && !!exportId,
    refetchInterval: (query) => (query.state.data && ['done', 'failed'].includes(query.state.data.status) ? false : pollMs),
  });
}

export interface CaptureAskTurn {
  question: string;
  /** The answer so far, then the whole answer. */
  answer: string;
  sources: CaptureAskSource[];
  citations: CaptureAskSource[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

/**
 * A conversation with Ask: each `ask(question)` appends a turn whose answer
 * streams in, with the earlier turns sent as history. `reset()` starts over.
 */
export function useCaptureAsk(accountId: Id, scope?: CaptureAskInput['scope']) {
  const [turns, setTurns] = useState<CaptureAskTurn[]>([]);
  const update = (index: number, patch: Partial<CaptureAskTurn>) =>
    setTurns((all) => all.map((turn, i) => (i === index ? { ...turn, ...patch, answer: patch.answer ?? turn.answer } : turn)));
  const ask = useCallback(
    async (question: string) => {
      if (!accountId) return;
      const history = turns
        .filter((t) => t.status === 'done')
        .flatMap((t) => [
          { role: 'user' as const, content: t.question },
          { role: 'assistant' as const, content: t.answer },
        ]);
      const index = turns.length;
      setTurns((all) => [...all, { question, answer: '', sources: [], citations: [], status: 'streaming' }]);
      let text = '';
      try {
        const result = await askCapture(accountId, { question, history, scope }, (event) => {
          if (event.type === 'sources') update(index, { sources: event.sources });
          if (event.type === 'delta') {
            text += event.text;
            update(index, { answer: text });
          }
        });
        update(index, { answer: result.answer, citations: result.citations, status: 'done' });
      } catch (error) {
        update(index, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    },
    [accountId, scope, turns],
  );
  return { turns, ask, reset: () => setTurns([]), streaming: turns.some((t) => t.status === 'streaming') };
}
