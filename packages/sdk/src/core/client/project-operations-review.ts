import * as P from '../rest/projects-client';

import type { DropFirst } from './binding-types';
export function bindProjectOperationsReview(projectId: string) {
  return {
    sessions: {
      /** One page of sessions as a bare array. See `listPage` for `next_cursor`. */
      list: (options?: Parameters<typeof P.listProjectSessions>[1]) =>
        P.listProjectSessions(projectId, options),
      /** One keyset page plus its continuation token. The list is bounded —
       *  walk it with `next_cursor`, and use `get(sessionId)` to resolve one
       *  session rather than paging in search of it. */
      listPage: (options?: Parameters<typeof P.listProjectSessionsPage>[1]) =>
        P.listProjectSessionsPage(projectId, options),
      create: (input?: Parameters<typeof P.createProjectSession>[1]) =>
        P.createProjectSession(projectId, input),
      /** Pre-create the session a present user is about to start. Ordinary session; ignore failures. */
      ensureWarm: () => P.ensureWarmProjectSession(projectId),
      /** @deprecated Navigate to `ensureWarm()`'s session and prompt it. Removed in the next major. */
      claimWarm: (input: Parameters<typeof P.claimWarmProjectSession>[1]) =>
        P.claimWarmProjectSession(projectId, input),
    },

    /** Channels and the caller's DMs (`project_channels` flag). A session joins one with `sessions.create({ space_id })`. */
    spaces: {
      list: () => P.listProjectSpaces(projectId),
      create: (input: Parameters<typeof P.createProjectSpace>[1]) => P.createProjectSpace(projectId, input),
      update: (...a: DropFirst<Parameters<typeof P.updateProjectSpace>>) => P.updateProjectSpace(projectId, ...a),
      /** The caller's DM with an agent, created on the first call. */
      dm: (agentName: string) => P.getOrCreateProjectDm(projectId, agentName),
    },

    /** Review Center — the per-project human-in-the-loop inbox (change requests, tool approvals, agent outputs/decisions). */
    review: {
      /** One page of the inbox. Walk the rest with `next_cursor` → `cursor`. */
      list: (params?: Parameters<typeof P.listReviewItems>[1]) =>
        P.listReviewItems(projectId, params),
      /** The needs-you counts, in total and by session. For a badge, not the list. */
      summary: () => P.getReviewSummary(projectId),
      get: (reviewItemId: string) => P.getReviewItem(projectId, reviewItemId),
      submit: (input: Parameters<typeof P.submitReviewItem>[1]) =>
        P.submitReviewItem(projectId, input),
      act: (...a: DropFirst<Parameters<typeof P.actReviewItem>>) =>
        P.actReviewItem(projectId, ...a),
      bulkAct: (input: Parameters<typeof P.bulkActReviewItems>[1]) =>
        P.bulkActReviewItems(projectId, input),
    },

    /** The manager inbox of connector-gated actions awaiting approve/deny (APPROVE / ASK / BLOCK). */
    approvals: {
      list: (options?: Parameters<typeof P.listPendingApprovals>[1]) =>
        P.listPendingApprovals(projectId, options),
      resolve: (...a: DropFirst<Parameters<typeof P.resolveApproval>>) =>
        P.resolveApproval(projectId, ...a),
      sessionsNeedingInput: (options?: Parameters<typeof P.listSessionsNeedingInput>[1]) =>
        P.listSessionsNeedingInput(projectId, options),
    },

    /** Gateway observability — LLM request logs, cost/latency rollups, budgets, gateway API keys. */
  };
}
