import { cookies } from 'next/headers';

import { LlmCatalogBootstrap } from '@/components/projects/llm-catalog-bootstrap';
import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';

interface ProjectLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

/**
 * Shell for every /projects/[id] route.
 *
 * It deliberately does NOT verify the session. Middleware default-denies every
 * route outside PUBLIC_ROUTES, so an unauthenticated request never reaches this
 * layout — it is already redirected to /auth. Re-checking here meant a second
 * GoTrue round-trip on every project switch and hard load, in series behind the
 * one middleware had just made.
 *
 * `project-layout-auth-contract.test.ts` pins that invariant: adding '/projects'
 * to PUBLIC_ROUTES fails the suite rather than silently rendering this shell to
 * a signed-out visitor.
 *
 * The bare `await cookies()` stays. It is the deliberate opt-in that keeps this
 * subtree dynamically rendered; removing it changes rendering semantics well
 * beyond the scope of this change.
 */
export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  void (await cookies());

  const { id: projectId } = await params;

  return (
    <ProjectAccessBoundary projectId={projectId}>
      <LlmCatalogBootstrap projectId={projectId} />
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </ProjectAccessBoundary>
  );
}
