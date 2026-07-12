'use client';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { MailWarning } from 'lucide-react';

/**
 * Pending invites — `accounts.invites` lists invitations that have been sent
 * but not yet accepted. Read-only here; the members section creates them.
 */
export function InvitesSection({ accountId }: { accountId: string }) {
  const invites = useQuery({
    queryKey: ['account-invites', accountId],
    queryFn: () => kortix.accounts.invites(accountId),
  });

  const items = invites.data ?? [];

  // Quiet when there's nothing pending and the load succeeded.
  if (invites.isSuccess && items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Pending invites</h3>
      <Card className="divide-y divide-border p-0">
        {invites.isLoading && (
          <div className="p-4">
            <Skeleton className="h-5 w-56" />
          </div>
        )}
        {invites.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load invites.
          </div>
        )}
        {items.map((inv, i) => (
          <div key={inv.invite_id ?? inv.email ?? i} className="flex items-center gap-3 px-4 py-3">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-muted">
              <MailWarning className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{inv.email ?? 'Invited user'}</div>
              <div className="truncate text-xs text-muted-foreground">
                {inv.created_at ? `Invited ${relativeTime(inv.created_at)}` : ''}
                {inv.expires_at
                  ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`
                  : ''}
              </div>
            </div>
            <Badge variant="outline" className="capitalize">
              {inv.initial_role ?? 'member'}
            </Badge>
          </div>
        ))}
      </Card>
    </section>
  );
}
