'use client';


import { ProjectSidebar } from '@/components/project-sidebar';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { ApiError } from '@kortix/sdk';
import { SessionIdsProvider } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { SidebarToggle } from '@kortix/ui/icons';
import { SidebarEdgePeek, SidebarInset, SidebarProvider, useSidebar } from '@kortix/ui/sidebar';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeftIcon, FolderDashedIcon } from '@phosphor-icons/react';

/** 403/404 from the API — access denied or the project doesn't exist here. */
function isAccessError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404);
}

/**
 * Every project page: Lumen's sidebar beside the page, in Kortix's layout (an
 * inset sidebar that collapses offcanvas, a sheet on a phone).
 */
export function ProjectShell({
  children,
  pageHasSidebarOpener = false,
}: {
  children: React.ReactNode;
  /** The page draws its own sidebar opener (the session header does). */
  pageHasSidebarOpener?: boolean;
}) {
  const params = useParams();
  const projectId = String(params.id);
  const sessionId = params.sessionId ? String(params.sessionId) : undefined;

  const project = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => kortix.project(projectId).get(),
    // 403/404 never recovers on retry — fail fast instead of spamming.
    retry: (count, err) => !isAccessError(err) && count < 2,
  });

  if (project.isError && isAccessError(project.error)) return <AccessDenied />;

  return (
    // The project (and session) every @kortix/ui component below reads.
    <SessionIdsProvider projectId={projectId} sessionId={sessionId}>
      <SidebarProvider>
        <ProjectSidebar projectId={projectId} projectName={project.data?.name} />
        <SidebarInset className="h-dvh min-h-0 overflow-hidden">
          <ProjectMain opener={!pageHasSidebarOpener}>{children}</ProjectMain>
        </SidebarInset>
      </SidebarProvider>
    </SessionIdsProvider>
  );
}

function ProjectMain({ children, opener }: { children: React.ReactNode; opener: boolean }) {
  const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar();
  const hidden = opener && (isMobile || state === 'collapsed');
  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Collapsed: hover the left edge to peek at the sidebar. */}
      <SidebarEdgePeek />
      {hidden && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open sidebar"
          onClick={() => (isMobile ? setOpenMobile(true) : toggleSidebar())}
          className="absolute top-2 left-2 z-30"
        >
          <SidebarToggle />
        </Button>
      )}
      <div className={hidden ? 'flex min-h-0 flex-1 flex-col pl-10' : 'flex min-h-0 flex-1 flex-col'}>
        {children}
      </div>
    </div>
  );
}

/** Shown when the API key can't see the project (403/404) — instead of a
 *  retry-spamming broken shell. */
function AccessDenied() {
  return (
    <div className="grid h-dvh place-items-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
          <FolderDashedIcon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 text-lg font-medium">Project not available</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          This project doesn&apos;t exist, or your API key doesn&apos;t have access to it. Pick one
          from your projects to continue.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeftIcon className="size-4" /> All projects
          </Link>
        </Button>
      </div>
    </div>
  );
}
