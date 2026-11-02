/**
 * The agents of the open session, read live, and what the panels do to them.
 *
 * One hook for `/agents`, `/workflows` and the tray segment, so they read the
 * SAME SDK queries with the SAME options: the panel opens on a warm cache and
 * costs no extra request. Every read and write is an `@kortix/sdk` call:
 *
 * - children: `useSessionChildren` (polled every 5 s), teammates:
 *   `useTeammates` (flag `agent_teams`);
 * - workflow runs: `useSessionWorkflows` on this session, plus the runner
 *   session of up to {@link RUNNER_READS} background runs: a background run's
 *   live progress is on its runner's box, the parent lists its last known state;
 * - held messages: `usePeerMessages(…, 'in')` with `approve` / `deny`;
 * - stop an agent: `kortix().session(p, s).stop()`; control a run:
 *   `useSessionWorkflows().control` (a background run asked on the parent is
 *   followed to its runner by the SDK).
 *
 * Every action reports one sentence in `notice`, which the panel prints.
 */

import type { WorkflowControlBody, WorkflowRunMetadata } from '@kortix/sdk';
import {
  qk,
  useFeatureFlag,
  usePeerMessages,
  useSessionChildren,
  useSessionView,
  useSessionWorkflows,
  useTeammates,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { workflowRunDocs } from '../session/transcript/workflow-card.tsx';

import { errorText } from '../../commands/session-actions.ts';
import { kortix } from '../../kortix.ts';
import {
  type AgentGroups,
  type RunRow,
  agentGroups,
  heldMessages,
  runRowOf,
  runSessionIds,
} from './agents-model.ts';

const CHILDREN_POLL_MS = 5_000;
const CHILDREN_LIMIT = 50;
/** Background runs whose runner session is read live. A fixed count: hooks cannot vary. */
export const RUNNER_READS = 3;

export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

export interface StopTarget {
  sessionId: string;
  title: string;
}

export interface SessionAgents {
  ready: boolean;
  loading: boolean;
  groups: AgentGroups;
  runs: RunRow[];
  held: ReturnType<typeof heldMessages>;
  notice: Notice | null;
  stop(target: StopTarget): void;
  control(run: RunRow, body: WorkflowControlBody): void;
  approve(messageId: string): void;
  deny(messageId: string): void;
}

const CONTROL_DONE: Record<WorkflowControlBody['action'], string> = {
  pause: 'Run paused. Running agents finish; no new agent starts.',
  resume: 'Run resumed.',
  stop: 'Run stopped.',
  restart_agent: 'Agent restarted.',
};

const CONTROL_VERB: Record<WorkflowControlBody['action'], string> = {
  pause: 'pause the run',
  resume: 'resume the run',
  stop: 'stop the run',
  restart_agent: 'restart the agent',
};

/**
 * The runner sessions of the newest background runs, at most {@link RUNNER_READS}. A finished
 * run too: its agents are on its runner's box, and the parent's copy lists none of them.
 */
export function backgroundRunners(runs: readonly RunRow[]): string[] {
  const out: string[] = [];
  for (const run of runs) {
    if (!run.runnerSessionId) continue;
    if (!out.includes(run.runnerSessionId)) out.push(run.runnerSessionId);
    if (out.length >= RUNNER_READS) break;
  }
  return out;
}

/** The parent's copy of each run, replaced by the runner's live copy where one was read. */
export function mergeLiveRuns(
  own: readonly RunRow[],
  live: readonly (readonly WorkflowRunMetadata[] | undefined)[],
): RunRow[] {
  const byId = new Map<string, RunRow>();
  for (const list of live) {
    for (const raw of list ?? []) {
      const row = runRowOf(raw);
      if (row && !byId.has(row.runId)) byId.set(row.runId, row);
    }
  }
  return own.map((run) => {
    const fresh = byId.get(run.runId);
    // The runner runs it in the foreground; this session still knows it as a background run.
    return fresh ? { ...fresh, runnerSessionId: run.runnerSessionId } : run;
  });
}

export function useSessionAgents(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): SessionAgents {
  const pid = projectId ?? '';
  const sid = sessionId ?? '';
  const ready = Boolean(projectId && sessionId);
  const queryClient = useQueryClient();
  const teams = useFeatureFlag(projectId, 'agent_teams').enabled;

  const children = useSessionChildren(pid, sid, {
    enabled: ready,
    refetchInterval: CHILDREN_POLL_MS,
    limit: CHILDREN_LIMIT,
  });
  const teammates = useTeammates(projectId, sessionId, { enabled: ready && teams });
  const workflows = useSessionWorkflows(projectId, sessionId, { enabled: ready });
  const peers = usePeerMessages(projectId, sessionId, 'in');

  const ownRuns = useMemo(
    () => (workflows.data ?? []).map((run) => runRowOf(run)).filter((run): run is RunRow => !!run),
    [workflows.data],
  );
  const runners = backgroundRunners(ownRuns);
  const live0 = useSessionWorkflows(projectId, runners[0], { enabled: ready && !!runners[0] });
  const live1 = useSessionWorkflows(projectId, runners[1], { enabled: ready && !!runners[1] });
  const live2 = useSessionWorkflows(projectId, runners[2], { enabled: ready && !!runners[2] });
  // A runner's box sleeps after its run: then its own log holds the final run document.
  const log0 = useSessionView(projectId ?? '', runners[0] ?? '', {
    enabled: ready && !!runners[0] && !live0.data?.length,
  });
  const log1 = useSessionView(projectId ?? '', runners[1] ?? '', {
    enabled: ready && !!runners[1] && !live1.data?.length,
  });
  const log2 = useSessionView(projectId ?? '', runners[2] ?? '', {
    enabled: ready && !!runners[2] && !live2.data?.length,
  });
  const runs = useMemo(
    () =>
      mergeLiveRuns(ownRuns, [
        live0.data,
        live1.data,
        live2.data,
        ...[log0.thread, log1.thread, log2.thread].map((thread) =>
          thread
            ? (workflowRunDocs(thread.messages) as unknown as WorkflowRunMetadata[])
            : undefined,
        ),
      ]),
    [ownRuns, live0.data, live1.data, live2.data, log0.thread, log1.thread, log2.thread],
  );

  const groups = useMemo(
    () =>
      agentGroups({
        leadSessionId: sid,
        children: children.sessions,
        teammates: teammates.data ?? [],
        exclude: runSessionIds(runs),
      }),
    [sid, children.sessions, teammates.data, runs],
  );
  const held = useMemo(() => heldMessages(peers.data, sid), [peers.data, sid]);

  const [notice, setNotice] = useState<Notice | null>(null);

  const stop = useCallback(
    (target: StopTarget) => {
      if (!pid) return;
      setNotice({ text: `Stopping ${target.title}…`, tone: 'info' });
      kortix()
        .session(pid, target.sessionId)
        .stop()
        .then(() => {
          setNotice({ text: `${target.title} stopped.`, tone: 'info' });
          void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(pid) });
        })
        .catch((error: unknown) =>
          setNotice({ text: `Could not stop ${target.title}. ${errorText(error)}`, tone: 'error' }),
        );
    },
    [pid, queryClient],
  );

  const { control: controlMutation } = workflows;
  const control = useCallback(
    (run: RunRow, body: WorkflowControlBody) => {
      controlMutation.mutate(
        { runId: run.runId, body },
        {
          onSuccess: () => setNotice({ text: CONTROL_DONE[body.action], tone: 'info' }),
          onError: (error: unknown) =>
            setNotice({
              text: `Could not ${CONTROL_VERB[body.action]}. ${errorText(error)}`,
              tone: 'error',
            }),
        },
      );
    },
    [controlMutation],
  );

  const { approve: approveMutation, deny: denyMutation } = peers;
  const approve = useCallback(
    (messageId: string) =>
      approveMutation.mutate(messageId, {
        onSuccess: () => setNotice({ text: 'Message delivered.', tone: 'info' }),
        onError: (error: unknown) =>
          setNotice({ text: `Could not deliver the message. ${errorText(error)}`, tone: 'error' }),
      }),
    [approveMutation],
  );
  const deny = useCallback(
    (messageId: string) =>
      denyMutation.mutate(messageId, {
        onSuccess: () => setNotice({ text: 'Message denied.', tone: 'info' }),
        onError: (error: unknown) =>
          setNotice({ text: `Could not deny the message. ${errorText(error)}`, tone: 'error' }),
      }),
    [denyMutation],
  );

  return {
    ready,
    loading: ready && (children.isLoading || workflows.isLoading),
    groups,
    runs,
    held,
    notice,
    stop,
    control,
    approve,
    deny,
  };
}
