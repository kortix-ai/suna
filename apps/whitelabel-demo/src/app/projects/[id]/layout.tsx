import { BindWorkspace, SignedIn } from '@/components/workspace-access';

/**
 * Every /projects/<kortixProjectId>/** page runs inside a Lumen workspace.
 * Convex maps the project id to the workspace and checks membership; the
 * SDK bearer becomes `ws.<workspaceId>`, and the proxy derives the Kortix
 * token from that workspace. A project id from the URL never selects a
 * credential, so a non-member sees "not available" and every call is refused.
 */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <SignedIn>
      <BindWorkspace>{children}</BindWorkspace>
    </SignedIn>
  );
}
