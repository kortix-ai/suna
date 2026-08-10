'use client';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';

/**
 * Workspaces in the selected account — `workspaces.listForAccount(accountId)`. Each
 * row links to the workspace detail page at `/workspaces/[id]`.
 */
export function WorkspacesSection({ accountId }: { accountId: string }) {
  const workspaces = useQuery({
    queryKey: ['account-workspaces', accountId],
    queryFn: () => kortix.workspaces.listForAccount(accountId),
  });

  const items = workspaces.data ?? [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Workspaces in this account</h3>
      <Card className="divide-y divide-border p-0">
        {workspaces.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        )}
        {workspaces.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load workspaces.
          </div>
        )}
        {workspaces.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No workspaces in this account yet.
          </div>
        )}
        {items.map((p, i) => (
          <Link
            key={p.workspace_id ?? i}
            href={`/workspaces/${p.workspace_id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
          >
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
              <FolderGit2 className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name ?? p.workspace_id}</div>
              <div className="truncate text-xs text-muted-foreground">
                {p.updated_at ? `Updated ${relativeTime(p.updated_at)}` : p.workspace_id}
              </div>
            </div>
          </Link>
        ))}
      </Card>
    </section>
  );
}
