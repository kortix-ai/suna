import * as P from '../rest/projects-client';
import { controlSessionWorkflowRun, listRuntimeWorkflowRuns } from '../session/runtime-workflows';

import type { SessionBindingContext } from './session-context';

/**
 * The multi-agent verbs of one session: the agents it can reach, the messages
 * it sends and receives, who may message it, its team's task list (when it
 * leads a team, flag `agent_teams`), and the workflow runs its box serves.
 */
export function bindSessionMultiAgent(ctx: SessionBindingContext) {
  const { projectId, sessionId } = ctx;
  return {
    /** The agents this session can message (`list_agents`). */
    reachable: (options?: { scope?: P.ReachableScope }) => P.getSessionReachableAgents(projectId, sessionId, options),
    /** Who may send this session a message: `accept`, `hold` or `refuse`. */
    setInbound: (inbound: P.SessionInbound) => P.setSessionInbound(projectId, sessionId, inbound),
    peerMessages: {
      /** Send a message from this session (`send_message`). */
      send: (body: P.PeerMessageSendBody) => P.sendPeerMessage(projectId, sessionId, body),
      /** Received (`in`), sent (`out`), or both. */
      list: (options?: { direction?: 'in' | 'out' }) => P.listPeerMessages(projectId, sessionId, options),
      /** Deliver a held message this session received. */
      approve: (messageId: string) => P.approvePeerMessage(projectId, sessionId, messageId),
      /** Drop a held message this session received. */
      deny: (messageId: string) => P.denyPeerMessage(projectId, sessionId, messageId),
    },
    /** The shared task list of the team this session leads. */
    tasks: {
      list: () => P.listSessionTasks(projectId, sessionId),
      create: (body: P.SessionTaskCreateBody) => P.createSessionTask(projectId, sessionId, body),
      update: (seq: number, body: P.SessionTaskUpdateBody) => P.updateSessionTask(projectId, sessionId, seq, body),
      remove: (seq: number) => P.deleteSessionTask(projectId, sessionId, seq),
    },
    /** The workflow runs on this session's own box, newest first (a background run with its runner session). `list` starts the session when it sleeps. */
    workflows: {
      list: async () => listRuntimeWorkflowRuns((await ctx.ensureReady()).runtimeUrl),
      /**
       * Pause, resume, stop a run, or restart one of its agents (`session_id`). A background
       * run is controlled in its runner session: the parent's `409 run_in_runner` is followed
       * once. Never starts a session.
       */
      control: (runId: string, body: P.WorkflowControlBody) => controlSessionWorkflowRun(projectId, sessionId, runId, body),
    },
  };
}
