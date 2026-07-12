'use client';

import type { PermissionRequest, QuestionRequest } from '../runtime/wire-types';
import { create } from 'zustand';

// Cap on how many resolved request ids we remember. Request ids are unique per
// request, so this only needs to outlive the window in which a stale add (SSE
// reconnect hydrate, an `*.asked` echo, or a self-heal `list()` poll) could try
// to resurrect a request the user already answered. A few hundred comfortably
// covers any real session.
const RESOLVED_REQUEST_LIMIT = 200;

function recordResolved(ids: string[], requestId: string): string[] {
  if (ids.includes(requestId)) return ids;
  return [...ids, requestId].slice(-RESOLVED_REQUEST_LIMIT);
}

interface RuntimePendingState {
  permissions: Record<string, PermissionRequest>;
  questions: Record<string, QuestionRequest>;
  // Ids of questions/permissions the user already answered / rejected / dismissed.
  // `addQuestion`/`addPermission` ignore these so a resolved request can never be
  // resurrected by a stale add path, which would re-lock the chat input.
  // Insertion-ordered so the oldest entries prune once the cap is hit.
  resolvedQuestionIds: string[];
  resolvedPermissionIds: string[];
  // Sessions the user put in "allow all permissions" mode. The session ruleset
  // written server-side (see `allowAllPermissionsForSession`) should stop new
  // asks at the source; this flag is the client-side belt-and-braces — any ask
  // that still arrives for a flagged session gets auto-approved by the prompt
  // component — and it drives the "auto-approving" indicator UI.
  autoApproveAllSessions: Record<string, true>;

  addPermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: QuestionRequest) => void;
  removeQuestion: (requestId: string) => void;
  setAutoApproveAll: (sessionId: string, enabled: boolean) => void;
  clear: () => void;

  // Derived: all pending items for a specific session
  getSessionPendingCount: (sessionId: string) => number;
  getTotalPendingCount: () => number;
}

export const useRuntimePendingStore = create<RuntimePendingState>()((set, get) => ({
  permissions: {},
  questions: {},
  resolvedQuestionIds: [],
  resolvedPermissionIds: [],
  autoApproveAllSessions: {},

  addPermission: (req) =>
    set((state) => {
      // Never resurrect a permission the user already resolved — SSE reconnect
      // hydration, the `permission.asked` echo, and the self-heal poll all
      // funnel through here (mirrors the question guard below).
      if (state.resolvedPermissionIds.includes(req.id)) return state;
      return { permissions: { ...state.permissions, [req.id]: req } };
    }),

  removePermission: (requestId) =>
    set((state) => {
      const { [requestId]: _, ...rest } = state.permissions;
      return {
        permissions: rest,
        resolvedPermissionIds: recordResolved(state.resolvedPermissionIds, requestId),
      };
    }),

  addQuestion: (req) =>
    set((state) => {
      // Never resurrect a question the user already resolved. SSE reconnect
      // hydration, the `question.asked` echo, and the self-heal poll all funnel
      // through here, so this single guard covers every re-add path.
      if (state.resolvedQuestionIds.includes(req.id)) return state;
      return { questions: { ...state.questions, [req.id]: req } };
    }),

  removeQuestion: (requestId) =>
    set((state) => {
      const { [requestId]: _, ...rest } = state.questions;
      return {
        questions: rest,
        resolvedQuestionIds: recordResolved(state.resolvedQuestionIds, requestId),
      };
    }),

  setAutoApproveAll: (sessionId, enabled) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.autoApproveAllSessions;
      return { autoApproveAllSessions: enabled ? { ...rest, [sessionId]: true } : rest };
    }),

  clear: () =>
    set({
      permissions: {},
      questions: {},
      resolvedQuestionIds: [],
      resolvedPermissionIds: [],
      autoApproveAllSessions: {},
    }),

  getSessionPendingCount: (sessionId) => {
    const s = get();
    const permCount = Object.values(s.permissions).filter((p) => p.sessionID === sessionId).length;
    const qCount = Object.values(s.questions)
      .filter((q) => q.sessionID === sessionId)
      .reduce((sum, q) => sum + (q.questions?.length || 1), 0);
    return permCount + qCount;
  },

  getTotalPendingCount: () => {
    const s = get();
    const permCount = Object.keys(s.permissions).length;
    const qCount = Object.values(s.questions).reduce(
      (sum, q) => sum + (q.questions?.length || 1),
      0,
    );
    return permCount + qCount;
  },
}));
