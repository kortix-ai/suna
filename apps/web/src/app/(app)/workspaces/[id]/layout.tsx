import { cookies } from 'next/headers';

import { LlmCatalogBootstrap } from '@/components/workspaces/llm-catalog-bootstrap';
import { WorkspaceAccessBoundary } from '@/components/workspaces/workspace-access-boundary';
import { WorkspaceShell } from '@/features/workspace/workspace-layout/workspace-shell';

interface WorkspaceLayoutProps {
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
 * and `params`), and every child, starting with `WorkspaceAccessBoundary`, gates
 * its data behind an authenticated `getWorkspace` call.
 *
 * `workspace-layout-auth-contract.test.ts` pins the middleware invariant: adding
 * '/projects' to PUBLIC_ROUTES or STATIC_PUBLIC_ROUTES fails the suite rather
 * than silently widening what an unauthenticated visitor can reach.
 *
 * The bare `await cookies()` stays. It is the deliberate opt-in that keeps this
 * subtree dynamically rendered; removing it changes rendering semantics well
 * beyond the scope of this change.
 */
export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  void (await cookies());

  const { id: workspaceId } = await params;

  return (
    <WorkspaceAccessBoundary workspaceId={workspaceId}>
      <LlmCatalogBootstrap workspaceId={workspaceId} />
      <WorkspaceShell workspaceId={workspaceId}>{children}</WorkspaceShell>
    </WorkspaceAccessBoundary>
  );
}
