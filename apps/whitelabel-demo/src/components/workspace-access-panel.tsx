'use client';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, UserCheck } from 'lucide-react';
import Link from 'next/link';

function useApplicationUser() {
  return useQuery({
    queryKey: ['application-user'],
    queryFn: async () => {
      const response = await fetch('/api/auth/me');
      if (!response.ok) throw new Error('Not authenticated');
      return (await response.json()) as { userId: string };
    },
    staleTime: 60_000,
  });
}

export function ApplicationUserBadge({ workspaceId }: { workspaceId: string }) {
  const user = useApplicationUser();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-1.5 text-xs text-muted-foreground">
      <UserCheck className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Application user{' '}
        <span className="font-mono">{user.data?.userId ?? '…'}</span> — local
        workspace ownership controls access.
      </span>
      <Button asChild size="xs" variant="ghost">
        <Link href={`/workspaces/${workspaceId}/sessions`}>Access</Link>
      </Button>
    </div>
  );
}

export function WorkspaceAccessPanel({ workspaceId }: { workspaceId: string }) {
  const user = useApplicationUser();
  const sessions = useQuery({
    queryKey: qk.sessions(workspaceId),
    queryFn: () => kortix.workspace(workspaceId).sessions.list(),
    retry: false,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <UserCheck className="size-4 shrink-0 text-brand" />
          <span className="text-sm font-medium">Application identity</span>
        </div>
        <div className="mt-1 break-all font-mono text-xs">
          {user.isLoading
            ? 'resolving…'
            : (user.data?.userId ?? 'not signed in')}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          The wrapper records this local identity in its workspace ownership
          store. It does not send the identity as session or cost metadata to
          Kortix.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-brand" />
          <span className="text-sm font-medium">
            Sessions in this owned workspace
          </span>
          <span className="ml-auto font-mono text-sm">
            {sessions.isLoading ? (
              <Loading className="size-3.5" />
            ) : (
              (sessions.data?.length ?? '—')
            )}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          The wrapper checks local workspace ownership before it forwards the
          workspace-scoped session request. The request includes no application
          customer filter.
        </p>
        <div className="mt-1.5">
          <CallSnippet id="sessions.list" context={{ workspaceId }} />
        </div>
      </div>
    </div>
  );
}
