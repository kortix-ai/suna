'use client';

import { AuthScreen } from '@/components/auth-screen';
import { setActiveWorkspace } from '@/lib/session';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { ArrowLeftIcon, FolderDashedIcon } from '@phosphor-icons/react';
import { useConvexAuth, useQuery } from 'convex/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { createContext, useContext } from 'react';

/** A Lumen thread opens the session page by the Kortix ids Convex stored for it. */
export function threadPath(kortixProjectId: string, kortixSessionId: string) {
  return `/projects/${kortixProjectId}/sessions/${kortixSessionId}`;
}

/** Renders children only for a signed-in user; otherwise the sign-in screen. */
export function SignedIn({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }
  return isAuthenticated ? children : <AuthScreen />;
}

/** One state for "does not exist" and "not yours": the page never confirms another org's ids. */
export function NotAvailable() {
  return (
    <div className="grid h-dvh place-items-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="grid size-12 place-items-center rounded-full border border-border bg-card">
          <FolderDashedIcon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="mt-4 font-display text-2xl tracking-tight">Workspace not available</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          This workspace does not exist, or it belongs to an organization you are not a member of.
        </p>
        <Button asChild className="mt-5 gap-2">
          <Link href="/">
            <ArrowLeftIcon className="size-4" /> All workspaces
          </Link>
        </Button>
      </div>
    </div>
  );
}

const WorkspaceContext = createContext<Doc<'workspaces'> | null>(null);

/** The Lumen workspace this project page belongs to. */
export function useWorkspace(): Doc<'workspaces'> {
  const ws = useContext(WorkspaceContext);
  if (!ws) throw new Error('useWorkspace outside a project page');
  return ws;
}


/** Resolve the route's Kortix project id to its Lumen workspace and make it the SDK bearer. */
export function BindWorkspace({ children }: { children: React.ReactNode }) {
  const ws = useQuery(api.workspaces.byProject, { kortixProjectId: String(useParams().id) });
  if (ws === undefined) {
    return (
      <div className="grid min-h-dvh place-items-center bg-background">
        <Loading className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (ws === null) return <NotAvailable />;
  // Set during render, before any child mounts and calls the SDK.
  setActiveWorkspace(ws._id);
  return <WorkspaceContext.Provider value={ws}>{children}</WorkspaceContext.Provider>;
}
