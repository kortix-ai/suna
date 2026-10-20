'use client';

/**
 * The thread layout: a left rail (back to the workspace, workspace name, new
 * thread, the workspace's threads) + a main pane. Threads are Lumen's own
 * rows in Convex; each points at one Kortix session.
 */

import { ThemeMenu } from '@/components/theme';
import { threadPath, useWorkspace } from '@/components/workspace-access';
import { relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Button } from '@kortix/ui/button';
import { cn } from '@kortix/ui';
import { ScrollArea } from '@kortix/ui/scroll-area';
import { Skeleton } from '@kortix/ui/skeleton';
import { ArrowLeftIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from 'convex/react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export function ProjectShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const activeSessionId = params.sessionId ? String(params.sessionId) : null;
  const ws = useWorkspace();
  const projectId = ws.kortixProjectId ?? '';
  const threads = useQuery(api.threads.list, { workspaceId: ws._id });
  const workspaceHref = `/w/${ws._id}`;

  return (
    <div className="flex h-dvh bg-background">
      {/* Below md the sidebar collapses into the top bar in <main>. */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Back to workspace">
            <Link href={workspaceHref}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{ws.name}</div>
          <ThemeMenu />
        </div>

        <div className="px-3 pb-2">
          <Button asChild className="w-full justify-start gap-2" variant="secondary">
            <Link href={workspaceHref}>
              <PlusIcon className="size-4" /> New thread
            </Link>
          </Button>
        </div>

        <ScrollArea className="flex-1 px-2">
          <div className="space-y-0.5 pb-3">
            {threads === undefined &&
              Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="mx-1 my-1 h-9 rounded-md" />
              ))}
            {threads?.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">No threads yet.</p>
            )}
            {threads?.map((t) => (
              <Link
                key={t._id}
                href={threadPath(projectId, t.kortixSessionId)}
                className={cn(
                  'block rounded-md px-3 py-2 text-sm transition-colors',
                  t.kortixSessionId === activeSessionId
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                )}
              >
                <span className="block truncate">{t.title}</span>
                <span className="block truncate text-xs text-muted-foreground/70">
                  {relativeTime(new Date(t._creationTime).toISOString())}
                </span>
              </Link>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Back to workspace">
            <Link href={workspaceHref}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{ws.name}</span>
          <ThemeMenu />
        </div>
        {children}
      </main>
    </div>
  );
}
