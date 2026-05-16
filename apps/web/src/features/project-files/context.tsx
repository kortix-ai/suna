'use client';

/**
 * ProjectFilesContext — gives every hook in this feature access to the
 * current project's id and git ref. The route-level shell sets this once
 * (see `apps/web/src/app/projects/[id]/files/page.tsx`).
 *
 * Hooks read context, then pass `projectId` / `ref` into the plain API
 * functions in `./api/opencode-files.ts`. The API functions themselves
 * stay pure — no React, no implicit ambient state.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface ProjectFilesContextValue {
  projectId: string;
  /** Git ref (branch / tag / sha) — usually the project's default_branch */
  ref: string;
}

const ProjectFilesContext = createContext<ProjectFilesContextValue | null>(null);

export function ProjectFilesProvider({
  value,
  children,
}: {
  value: ProjectFilesContextValue;
  children: ReactNode;
}) {
  return (
    <ProjectFilesContext.Provider value={value}>{children}</ProjectFilesContext.Provider>
  );
}

/**
 * Read the active project context. Returns `null` outside a provider —
 * callers should handle that gracefully (e.g. by short-circuiting their
 * React Query `enabled` flag).
 */
export function useProjectContext(): ProjectFilesContextValue | null {
  return useContext(ProjectFilesContext);
}

/** Strict variant: throws if no provider above. Use in hot paths that
 *  cannot meaningfully render without project context. */
export function useProjectContextStrict(): ProjectFilesContextValue {
  const ctx = useContext(ProjectFilesContext);
  if (!ctx) {
    throw new Error(
      'useProjectContextStrict: <ProjectFilesProvider> is missing in the tree',
    );
  }
  return ctx;
}

export { ProjectFilesContext };
