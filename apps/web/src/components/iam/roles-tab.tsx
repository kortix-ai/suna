'use client';

// Roles tab on the account page. Lists system + custom roles in one table.
// System roles are read-only (built into the catalog); custom roles can be
// edited or deleted by users with role.create/update/delete.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { listRoles, type IamRole } from '@/lib/iam-client';
import { CreateRoleDialog } from '@/components/iam/create-role-dialog';

interface RolesTabProps {
  accountId: string;
  canCreate: boolean;
}

export function RolesTab({ accountId, canCreate }: RolesTabProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const all = rolesQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.key.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false),
    );
  }, [rolesQuery.data, search]);

  // Group by resource_type so the table reads as "Account roles · Project
  // roles · …" rather than one undifferentiated list.
  const grouped = useMemo(() => {
    const map = new Map<string, IamRole[]>();
    for (const r of filtered) {
      const arr = map.get(r.resource_type) ?? [];
      arr.push(r);
      map.set(r.resource_type, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Roles</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            System roles ship with the platform. Create custom roles to bundle
            exactly the permissions your account needs.
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Create a role
          </Button>
        )}
      </header>

      <div className="border-b border-border/60 px-6 py-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roles by name or key..."
            className="h-9 pl-9"
          />
        </div>
      </div>

      {rolesQuery.isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            {(rolesQuery.error as Error)?.message || 'Failed to load roles'}
          </p>
        </div>
      )}

      {rolesQuery.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
      )}

      {!rolesQuery.isLoading && filtered.length === 0 && (
        <div className="px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {search ? 'No roles match your search' : 'No roles available'}
          </p>
        </div>
      )}

      {!rolesQuery.isLoading && grouped.length > 0 && (
        <div className="divide-y divide-border/60">
          {grouped.map(([resourceType, roles]) => (
            <div key={resourceType}>
              <div className="bg-muted/20 px-6 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {capitalize(resourceType)}{resourceType === 'account' ? '' : ' resources'}
              </div>
              <ul className="divide-y divide-border/60">
                {roles.map((r) => (
                  <li
                    key={r.role_id}
                    className="flex cursor-pointer items-center gap-3 px-6 py-3 transition-colors hover:bg-muted/30"
                    onClick={() =>
                      router.push(`/accounts/${accountId}/roles/${r.role_id}`)
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {r.name}
                        </span>
                        {r.is_system ? (
                          <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                            system
                          </Badge>
                        ) : (
                          <Badge className="h-4 rounded-md px-1 text-[9px] font-normal">
                            custom
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <code className="font-mono">{r.key}</code>
                        {r.description && (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span className="truncate">{r.description}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
      />
    </section>
  );
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
