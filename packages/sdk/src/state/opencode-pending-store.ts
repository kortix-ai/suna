'use client';

import { create } from 'zustand';
import type { PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2/client';

// Cap on how many resolved question ids we remember. Question ids are unique per
// request, so this only needs to outlive the window in which a stale add (SSE
// reconnect hydrate, a `question.asked` echo, or the self-heal `question.list()`
// poll) could try to resurrect a question the user already answered. A few hundred
// comfortably covers any real session.
const RESOLVED_QUESTION_LIMIT = 200;

interface OpenCodePendingState {
  permissions: Record<string, PermissionRequest>;
  questions: Record<string, QuestionRequest>;
  // Ids of questions the user already answered / rejected / dismissed.
  // `addQuestion` ignores these so a resolved question can never be resurrected by
  // a stale add path, which would re-lock the chat input. Insertion-ordered so the
  // oldest entries prune once the cap is hit.
  resolvedQuestionIds: string[];

  addPermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: QuestionRequest) => void;
  removeQuestion: (requestId: string) => void;
  clear: () => void;

  // Derived: all pending items for a specific session
  getSessionPendingCount: (sessionId: string) => number;
  getTotalPendingCount: () => number;
}

export const useOpenCodePendingStore = create<OpenCodePendingState>()((set, get) => ({
  permissions: {},
  questions: {},
  resolvedQuestionIds: [],

  addPermission: (req) =>
    set((state) => ({
      permissions: { ...state.permissions, [req.id]: req },
    })),

  removePermission: (requestId) =>
    set((state) => {
      const { [requestId]: _, ...rest } = state.permissions;
      return { permissions: rest };
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
      // Remember the id as resolved so a later stale add can't bring it back.
      const resolved = state.resolvedQuestionIds.includes(requestId)
        ? state.resolvedQuestionIds
        : [...state.resolvedQuestionIds, requestId].slice(-RESOLVED_QUESTION_LIMIT);
      return { questions: rest, resolvedQuestionIds: resolved };
    }),

  clear: () => set({ permissions: {}, questions: {}, resolvedQuestionIds: [] }),

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
    const qCount = Object.values(s.questions)
      .reduce((sum, q) => sum + (q.questions?.length || 1), 0);
    return permCount + qCount;
  },
}));
