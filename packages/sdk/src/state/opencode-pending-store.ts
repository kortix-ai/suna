'use client';

import { create } from 'zustand';
import type { PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2/client';

interface OpenCodePendingState {
  permissions: Record<string, PermissionRequest>;
  questions: Record<string, QuestionRequest>;

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
    set((state) => ({
      questions: { ...state.questions, [req.id]: req },
    })),

  removeQuestion: (requestId) =>
    set((state) => {
      const { [requestId]: _, ...rest } = state.questions;
      return { questions: rest };
    }),

  clear: () => set({ permissions: {}, questions: {} }),

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
