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
      /** The channel's Apps: deployed from one of its threads, only those the caller may open. */
      apps: (spaceId: string) => P.listProjectSpaceApps(projectId, spaceId),
      /** A channel's links: added ("Add link", pinned) or shared in its threads. Agents read the pinned ones. Only the creator or a project manager may remove one. */
      links: {
        list: (spaceId: string) => P.listProjectSpaceLinks(projectId, spaceId),
        add: (...a: DropFirst<Parameters<typeof P.addProjectSpaceLink>>) => P.addProjectSpaceLink(projectId, ...a),
        /** `pin(spaceId, linkId, pinned)`: the link, or null when unpinning removed it. */
        pin: (...a: DropFirst<Parameters<typeof P.pinProjectSpaceLink>>) => P.pinProjectSpaceLink(projectId, ...a),
        remove: (...a: DropFirst<Parameters<typeof P.removeProjectSpaceLink>>) => P.removeProjectSpaceLink(projectId, ...a),
      },
      /** The counts beside the channel's tab labels. */
      summary: (spaceId: string) => P.getProjectSpaceSummary(projectId, spaceId),
      /** `#general`'s "turned on again" line, or null. */
      generalNotice: () => P.getProjectSpaceGeneralNotice(projectId),
      /** The caller's Channels onboarding: the intro dialog and the `#general` "Get started" rows. */
      onboarding: {
        get: () => P.getChannelsOnboarding(projectId),
        /** Record one mark for the caller. Idempotent. */
        mark: (mark: P.ChannelsOnboardingMark) => P.markChannelsOnboarding(projectId, mark),
      },
    },

    /** Memory: the Markdown files of the project's Drive (`drives` flag). A layer key is `company` or a channel's or DM's space id. */
    memory: {
      /** One layer: its Drive folder and page counts. */
      layer: (layerKey: string) => P.getProjectMemoryLayer(projectId, layerKey),
      /** Recent changes: the 20 most recently changed files. */
      changes: (...a: DropFirst<Parameters<typeof P.listProjectMemoryChanges>>) => P.listProjectMemoryChanges(projectId, ...a),
      pages: {
        /** One page per Markdown file, newest first; `{ type }` filters. */
        list: (...a: DropFirst<Parameters<typeof P.listProjectMemoryPages>>) => P.listProjectMemoryPages(projectId, ...a),
        create: (...a: DropFirst<Parameters<typeof P.createProjectMemoryPage>>) => P.createProjectMemoryPage(projectId, ...a),
        get: (pageId: string) => P.getProjectMemoryPage(projectId, pageId),
        update: (...a: DropFirst<Parameters<typeof P.updateProjectMemoryPage>>) => P.updateProjectMemoryPage(projectId, ...a),
        delete: (pageId: string) => P.deleteProjectMemoryPage(projectId, pageId),
        history: (...a: DropFirst<Parameters<typeof P.listProjectMemoryHistory>>) => P.listProjectMemoryHistory(projectId, ...a),
      },
      /** Remember-box sentences, appended to the layer's `Notes.md`. */
      notes: {
        add: (...a: DropFirst<Parameters<typeof P.addProjectMemoryNote>>) => P.addProjectMemoryNote(projectId, ...a),
      },
      /** Undo the newest change of a page, by its version. */
      undo: (versionId: string) => P.undoProjectMemoryVersion(projectId, versionId),
      /** Search the pages the caller can read: `{ q, layer?, type?, limit? }`, `q` at least 2 characters. */
      search: (...a: DropFirst<Parameters<typeof P.searchProjectMemory>>) => P.searchProjectMemory(projectId, ...a),
      /** A thread's "Used memory": the files listed to its agent at the first turn. */
      usage: (sessionId: string) => P.getSessionMemoryUsage(projectId, sessionId),
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
