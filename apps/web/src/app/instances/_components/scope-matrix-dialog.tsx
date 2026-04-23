'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast as sonnerToast } from 'sonner';

import {
  getSandboxMemberScopes,
  updateSandboxMemberScope,
  type SandboxMemberScopes,
  type ScopeEffect,
  type SandboxMember,
} from '@/lib/platform-client';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { UserAvatar } from '@/components/ui/user-avatar';
import { IconLoader, IconSearch } from '@/components/ui/kortix-icons';

type RowEffect = 'inherit' | 'grant' | 'revoke';

export function ScopeMatrixDialog({
  open,
  onOpenChange,
  sandboxId,
  member,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxId: string;
  member: SandboxMember | null;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');

  const scopesQuery = useQuery({
    queryKey: ['sandbox', 'member-scopes', sandboxId, member?.user_id],
    queryFn: () => getSandboxMemberScopes(sandboxId, member!.user_id),
    enabled: open && !!member,
  });

  const mutation = useMutation({
    mutationFn: (input: { scope: string; effect: ScopeEffect }) =>
      updateSandboxMemberScope(sandboxId, member!.user_id, input.scope, input.effect),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['sandbox', 'member-scopes', sandboxId, member?.user_id],
      });
      queryClient.invalidateQueries({ queryKey: ['sandbox', 'members', sandboxId] });
    },
    onError: (err) => {
      sonnerToast.error(err instanceof Error ? err.message : 'Failed to update scope');
    },
  });

  const data = scopesQuery.data;
  const filtered = useFilteredGroups(data, filter);

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-border/60 border-b px-6 py-5">
          <div className="flex items-center gap-3">
            <UserAvatar
              email={member.email || member.user_id}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-[15px] font-semibold tracking-tight">
                Permissions for {member.email || member.user_id}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[12px]">
                {data ? (
                  <>
                    Inheriting from <span className="text-foreground font-medium">{data.role ?? 'none'}</span>
                    {(data.grants.length + data.revokes.length) > 0 ? (
                      <> · {data.grants.length + data.revokes.length} override{data.grants.length + data.revokes.length === 1 ? '' : 's'}</>
                    ) : null}
                  </>
                ) : (
                  'Loading role defaults and overrides…'
                )}
              </DialogDescription>
            </div>
          </div>
          <div className="relative mt-4">
            <IconSearch className="text-muted-foreground/60 absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter permissions…"
              className="h-9 pl-9"
            />
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {scopesQuery.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <IconLoader className="h-4 w-4 animate-spin" /> Loading permissions…
            </div>
          ) : scopesQuery.error ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              {scopesQuery.error instanceof Error
                ? scopesQuery.error.message
                : 'Failed to load permissions.'}
            </div>
          ) : !data ? null : (
            <div className="space-y-6">
              {filtered.map(({ group, items }) => (
                <section key={group} className="space-y-2">
                  <div className="text-muted-foreground/60 text-[11px] font-semibold uppercase tracking-[0.08em]">
                    {group}
                  </div>
                  <div className="space-y-1">
                    {items.map((item) => {
                      const current = currentEffect(item.scope, data);
                      const inheritedAllowed = data.inherited.includes(item.scope);
                      const pending =
                        mutation.isPending && mutation.variables?.scope === item.scope;
                      return (
                        <ScopeRow
                          key={item.scope}
                          label={item.label}
                          description={item.description}
                          effect={current}
                          inheritedAllowed={inheritedAllowed}
                          pending={pending}
                          onChange={(next) => {
                            const payload: ScopeEffect =
                              next === 'inherit' ? null : next;
                            mutation.mutate({ scope: item.scope, effect: payload });
                          }}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
              {filtered.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center text-sm">
                  No permissions match "{filter}".
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="border-border/60 bg-muted/20 border-t px-6 py-3">
          <p className="text-muted-foreground/70 text-[11px] leading-relaxed">
            <span className="text-foreground/70 font-medium">Inherit</span> follows
            the member's role. <span className="text-foreground/70 font-medium">Grant</span>{' '}
            forces the permission on; <span className="text-foreground/70 font-medium">Revoke</span> forces it off.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ScopeRow({
  label,
  description,
  effect,
  inheritedAllowed,
  pending,
  onChange,
}: {
  label: string;
  description: string;
  effect: RowEffect;
  inheritedAllowed: boolean;
  pending: boolean;
  onChange: (next: RowEffect) => void;
}) {
  return (
    <div
      className={cn(
        'border-border/60 bg-muted/20 flex items-start justify-between gap-4 rounded-xl border px-3.5 py-3',
        pending && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-[13px] font-medium">{label}</span>
          {effect === 'grant' ? (
            <Badge variant="success" size="sm">Granted</Badge>
          ) : effect === 'revoke' ? (
            <Badge variant="destructive" size="sm">Revoked</Badge>
          ) : inheritedAllowed ? (
            <Badge variant="muted" size="sm">Inherited · allowed</Badge>
          ) : (
            <Badge variant="muted" size="sm">Inherited · denied</Badge>
          )}
        </div>
        <p className="text-muted-foreground/80 mt-0.5 text-[11px] leading-snug">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-border/60 bg-background p-0.5">
        <SegmentButton active={effect === 'revoke'} onClick={() => onChange('revoke')} tone="destructive">
          Revoke
        </SegmentButton>
        <SegmentButton active={effect === 'inherit'} onClick={() => onChange('inherit')} tone="neutral">
          Inherit
        </SegmentButton>
        <SegmentButton active={effect === 'grant'} onClick={() => onChange('grant')} tone="success">
          Grant
        </SegmentButton>
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'success' | 'destructive' | 'neutral';
  children: React.ReactNode;
}) {
  const activeTone =
    tone === 'success'
      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
      : tone === 'destructive'
        ? 'bg-destructive/15 text-destructive'
        : 'bg-muted text-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors',
        active
          ? activeTone
          : 'text-muted-foreground/70 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function currentEffect(scope: string, data: SandboxMemberScopes): RowEffect {
  if (data.grants.includes(scope)) return 'grant';
  if (data.revokes.includes(scope)) return 'revoke';
  return 'inherit';
}

function useFilteredGroups(
  data: SandboxMemberScopes | undefined,
  filter: string,
) {
  return useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const byScope = new Map(data.catalog.map((c) => [c.scope, c]));
    const groups: Array<{ group: string; items: typeof data.catalog }> = [];
    for (const [group, scopes] of Object.entries(data.groups)) {
      const items = scopes
        .map((s) => byScope.get(s))
        .filter((c): c is SandboxMemberScopes['catalog'][number] => Boolean(c))
        .filter(
          (c) =>
            !q ||
            c.scope.toLowerCase().includes(q) ||
            c.label.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q),
        );
      if (items.length > 0) groups.push({ group, items });
    }
    return groups;
  }, [data, filter]);
}
