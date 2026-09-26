import { cookies } from 'next/headers';

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
 * dot-free /projects/* path outside PUBLIC_ROUTES and STATIC_PUBLIC_ROUTES, so
 * almost every unauthenticated request is already redirected to /auth before it
 * reaches this layout. Re-checking here meant a second GoTrue round-trip on
 * every project switch and hard load, in series behind the one middleware had
 * just made.
 *
 * A dotted pathname (e.g. /projects/x.png) skips middleware entirely
 * (middleware.ts's `pathname.includes('.')` check and its matcher's image-file
 * exclusion) — that gap is pre-existing and out of scope here. It stays safe
 * because this layout renders no server-side data of its own (only `cookies()`
 * and `params`), and every child, starting with `ProjectAccessBoundary`, gates
 * its data behind an authenticated `getProject` call.
 *
 * `project-layout-auth-contract.test.ts` pins the middleware invariant: adding
 * '/projects' to PUBLIC_ROUTES or STATIC_PUBLIC_ROUTES fails the suite rather
 * than silently widening what an unauthenticated visitor can reach.
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
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </ProjectAccessBoundary>
  );
}
