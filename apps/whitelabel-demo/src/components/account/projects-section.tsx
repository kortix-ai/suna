'use client';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';

/**
 * Projects in the selected account — `projects.listForAccount(accountId)`. Each
 * row links to the project detail page at `/projects/[id]`.
 */
export function ProjectsSection({ accountId }: { accountId: string }) {
  const projects = useQuery({
    queryKey: ['account-projects', accountId],
    queryFn: () => kortix.projects.listForAccount(accountId),
  });

  const items = (projects.data as any[]) ?? [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Projects in this account</h3>
      <Card className="divide-y divide-border p-0">
        {projects.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        )}
        {projects.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load projects.
          </div>
        )}
        {projects.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No projects in this account yet.
          </div>
        )}
        {items.map((p, i) => (
          <Link
            key={p.project_id ?? i}
            href={`/projects/${p.project_id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent"
          >
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
              <FolderGit2 className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name ?? p.project_id}</div>
              <div className="truncate text-xs text-muted-foreground">
                {p.updated_at ? `Updated ${relativeTime(p.updated_at)}` : p.project_id}
              </div>
            </div>
          </Link>
        ))}
      </Card>
    </section>
  );
}
