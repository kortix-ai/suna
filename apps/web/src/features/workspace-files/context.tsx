'use client';

/**
 * WorkspaceFilesContext — gives every hook in this feature access to the
 * current project's id and git ref. The route-level shell sets this once
 * (see `apps/web/src/app/projects/[id]/files/page.tsx`).
 *
 * Hooks read context, then pass `workspaceId` / `ref` into the plain API
 * functions in `./api/runtime-files.ts`. The API functions themselves
 * stay pure — no React, no implicit ambient state.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface WorkspaceFilesContextValue {
  workspaceId: string;
  /** Git ref (branch / tag / sha) — usually the workspace's default_branch */
  ref: string;
  /** Workspace default branch (so CR controls know when `ref` is a non-default version). */
  defaultBranch?: string;
}

const WorkspaceFilesContext = createContext<WorkspaceFilesContextValue | null>(null);

export function WorkspaceFilesProvider({
  value,
  children,
}: {
  value: WorkspaceFilesContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceFilesContext.Provider value={value}>{children}</WorkspaceFilesContext.Provider>
  );
}

/**
 * Read the active project context. Returns `null` outside a provider —
 * callers should handle that gracefully (e.g. by short-circuiting their
 * React Query `enabled` flag).
 */
export function useWorkspaceContext(): WorkspaceFilesContextValue | null {
  return useContext(WorkspaceFilesContext);
}

/** Strict variant: throws if no provider above. Use in hot paths that
 *  cannot meaningfully render without project context. */
export function useWorkspaceContextStrict(): WorkspaceFilesContextValue {
  const ctx = useContext(WorkspaceFilesContext);
  if (!ctx) {
    throw new Error(
      'useWorkspaceContextStrict: <WorkspaceFilesProvider> is missing in the tree',
    );
  }
  return ctx;
}

export { WorkspaceFilesContext };
