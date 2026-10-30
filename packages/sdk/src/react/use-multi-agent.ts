'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  approvePeerMessage,
  createSessionTask,
  deleteSessionTask,
  denyPeerMessage,
  getSessionReachableAgents,
  listPeerMessages,
  listProjectSessionsPage,
  listSessionTasks,
  updateSessionTask,
  type ProjectSession,
  type ReachableScope,
  type SessionTaskCreateBody,
  type SessionTaskUpdateBody,
  type WorkflowControlBody,
  type WorkflowRunMetadata,
} from '../core/rest/projects-client';
import { getProjectSession } from '../core/rest/projects-client/sessions';
import { projectSessionStartSeed } from '../core/rest/projects-client/session-sandbox';
import { controlRuntimeWorkflowRun, readSessionWorkflowRuns } from '../core/session/runtime-workflows';
import { getSandboxUrlForExternalId } from '../core/session/server-store/url-helpers';
import { getSessionRuntime } from '../core/session/session-runtime-registry';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** How often the multi-agent reads poll while the page is visible. */
const POLL_MS = 5_000;
/** A running workflow run polls faster: its agents start and finish every few seconds. */
const LIVE_RUN_POLL_MS = 2_000;
/** The most teammates a lead's list reads. */
const TEAMMATES_LIMIT = 50;

const poll = { refetchInterval: POLL_MS, refetchIntervalInBackground: false } as const;

/** The agents a session can message (`list_agents`): `mine` (default) or every live session of the project. */
export function useReachableAgents(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  scope: ReachableScope = 'mine',
) {
  return useQuery({
    queryKey: qk.project.sessionReachable(projectId ?? '', sessionId ?? '', scope),
    queryFn: () => getSessionReachableAgents(projectId as string, sessionId as string, { scope }),
    enabled: !!projectId && !!sessionId,
    ...contract('inventory'),
    ...poll,
  });
}

/**
 * A session's cross-session messages, newest first: received (`in`), sent
 * (`out`), or both. `approve` and `deny` decide a held message this session received.
 */
export function usePeerMessages(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  direction?: 'in' | 'out',
) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.project.sessionAgents(projectId ?? '', sessionId ?? '') });
  const query = useQuery({
    queryKey: qk.project.peerMessages(projectId ?? '', sessionId ?? '', direction ?? 'all'),
    queryFn: async () => (await listPeerMessages(projectId as string, sessionId as string, { direction })).messages,
    enabled: !!projectId && !!sessionId,
    ...contract('inventory'),
    ...poll,
  });
  const approve = useMutation({
    mutationFn: (messageId: string) => approvePeerMessage(projectId as string, sessionId as string, messageId),
    onSuccess: refresh,
  });
  const deny = useMutation({
    mutationFn: (messageId: string) => denyPeerMessage(projectId as string, sessionId as string, messageId),
    onSuccess: refresh,
  });
  return { ...query, approve, deny };
}

/** The shared task list of the team `leadSessionId` leads (flag `agent_teams`), with its mutations. */
export function useTeamTasks(
  projectId: string | null | undefined,
  leadSessionId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const key = qk.project.teamTasks(projectId ?? '', leadSessionId ?? '');
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await listSessionTasks(projectId as string, leadSessionId as string)).tasks,
    enabled: !!projectId && !!leadSessionId && (options.enabled ?? true),
    ...contract('inventory'),
    ...poll,
  });
  const create = useMutation({
    mutationFn: (body: SessionTaskCreateBody) => createSessionTask(projectId as string, leadSessionId as string, body),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ seq, body }: { seq: number; body: SessionTaskUpdateBody }) =>
      updateSessionTask(projectId as string, leadSessionId as string, seq, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (seq: number) => deleteSessionTask(projectId as string, leadSessionId as string, seq),
    onSuccess: refresh,
  });
  return { ...query, create, update, remove };
}

/** The teammates of a lead session (child sessions with metadata `team_lead`), newest activity first. */
export function useTeammates(
  projectId: string | null | undefined,
  leadSessionId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: qk.project.teammates(projectId ?? '', leadSessionId ?? ''),
    queryFn: async (): Promise<ProjectSession[]> =>
      (await listProjectSessionsPage(projectId as string, { teamLead: leadSessionId as string, limit: TEAMMATES_LIMIT }))
        .items,
    enabled: !!projectId && !!leadSessionId && (options.enabled ?? true),
    ...contract('inventory'),
    ...poll,
  });
}

/** The runtime URL a control goes to: the resolved one, else the one the running session's row names. */
async function runtimeUrlFor(projectId: string, sessionId: string): Promise<string> {
  const known = getSessionRuntime(projectId, sessionId)?.runtimeUrl;
  if (known) return known;
  const externalId = projectSessionStartSeed(await getProjectSession(projectId, sessionId))?.sandbox?.external_id;
  if (!externalId) throw new Error('This session is not running, so its workflow runs cannot change.');
  return getSandboxUrlForExternalId(externalId);
}

/**
 * The workflow runs on a session's box, newest first: the session that called
 * `workflow`, or a background run's runner session. A poll never starts a
 * stopped session. `control` pauses, resumes, stops a run or restarts an agent.
 */
export function useSessionWorkflows(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const key = qk.project.sessionWorkflows(projectId ?? '', sessionId ?? '');
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<WorkflowRunMetadata[]> =>
      (await readSessionWorkflowRuns(projectId as string, sessionId as string)).runs,
    enabled: !!projectId && !!sessionId && (options.enabled ?? true),
    ...contract('inventory'),
    refetchInterval: (state: { state: { data?: WorkflowRunMetadata[] } }) =>
      state.state.data?.some((run) => run.status === 'running') ? LIVE_RUN_POLL_MS : POLL_MS,
    refetchIntervalInBackground: false,
  });
  const control = useMutation({
    mutationFn: async ({ runId, body }: { runId: string; body: WorkflowControlBody }) =>
      controlRuntimeWorkflowRun(await runtimeUrlFor(projectId as string, sessionId as string), runId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { ...query, control };
}
