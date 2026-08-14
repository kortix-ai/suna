'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import { LlmCatalogBootstrap } from '@/components/projects/llm-catalog-bootstrap';
import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

/**
 * Client half of the desktop /projects/[id] shell.
 *
 * `useParams` resolves through desktop/nav-shim.tsx, which reads the real id
 * out of the live pathname rather than the `__shell__` value the page was
 * prerendered against.
 *
 * Like the web layout, this deliberately does NOT verify the session — every
 * child gates its own data behind an authenticated `getProject` call, starting
 * with ProjectAccessBoundary. The desktop shell has no middleware to
 * default-deny unauthenticated paths, so that boundary is the only gate here.
 */
export function ProjectLayoutClient({ children }: { children: ReactNode }) {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <ProjectAccessBoundary projectId={projectId}>
      <LlmCatalogBootstrap projectId={projectId} />
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </ProjectAccessBoundary>
  );
}
