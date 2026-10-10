'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
