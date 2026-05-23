'use client';

// Per-member permission boundary on the member detail page. Acts as a
// max-envelope — the IAM engine clips this member's effective
// permissions to the configured action-prefix list, even if explicit
// allow-policies cover more. Super-admins bypass.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldOff, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getMemberBoundary,
  setMemberBoundary,
} from '@/lib/iam-client';

interface PermissionBoundaryCardProps {
  accountId: string;
  userId: string;
  canManage: boolean;
}

export function PermissionBoundaryCard({
  accountId,
  userId,
  canManage,
}: PermissionBoundaryCardProps) {
  const queryClient = useQueryClient();
  const queryKey = ['iam-member-boundary', accountId, userId];

  const boundaryQuery = useQuery({
    queryKey,
    queryFn: () => getMemberBoundary(accountId, userId),
    staleTime: 30_000,
  });

  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  // Hydrate local state when the server data lands. Use a string-set
  // identity check to avoid stomping the user's edits if the query
  // refetches while they're typing.
  useEffect(() => {
    if (!boundaryQuery.isSuccess) return;
    setPrefixes(boundaryQuery.data?.allow_action_prefixes ?? []);
  }, [boundaryQuery.isSuccess, boundaryQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      setMemberBoundary(accountId, userId, {
        allow_action_prefixes: prefixes,
      }),
    onSuccess: () => {
      toast.success('Permission boundary updated');
      queryClient.invalidateQueries({ queryKey });
      // Permission probes need re-resolution since the clip just
      // changed; bust the IAM probe caches.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save boundary'),
  });

  const clearMutation = useMutation({
    mutationFn: () => setMemberBoundary(accountId, userId, null),
    onSuccess: () => {
      toast.success('Permission boundary cleared');
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setClearOpen(false);
      setPrefixes([]);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to clear boundary'),
  });

  function addPrefix(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError(null);
      return;
    }
    if (trimmed.length > 128) {
      setError('Each prefix must be ≤128 characters');
      return;
    }
    if (prefixes.includes(trimmed)) {
      setError('That prefix is already in the list');
      return;
    }
    setPrefixes((prev) => [...prev, trimmed]);
    setDraft('');
    setError(null);
  }

  const hasBoundary = boundaryQuery.data !== null && boundaryQuery.data !== undefined;
  const isLocallyEmpty = prefixes.length === 0;

  return (
    <SectionCard
      title="Permission boundary"
      description="Caps the max set of actions this member can ever use, no matter how many allow-policies they have. Super-admins are exempt."
    >
      <div className="space-y-4 px-6 py-5">
        {boundaryQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {!hasBoundary && (
              <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No boundary configured. All explicit allow-policies apply at
                full strength.
              </p>
            )}

            {hasBoundary && isLocallyEmpty && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                Boundary is an empty list — this member is effectively denied
                every action until you add prefixes or clear the boundary.
              </p>
            )}

            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">
                Allowed action prefixes. Use a trailing dot to cover a whole
                namespace (e.g.{' '}
                <span className="font-mono">project.</span> covers{' '}
                <span className="font-mono">project.read</span>,{' '}
                <span className="font-mono">project.session.start</span>, etc.).
              </div>
              {prefixes.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {prefixes.map((p) => (
                    <Badge
                      key={p}
                      variant="outline"
                      size="sm"
                      className="gap-1 pr-1 font-mono text-[11px]"
                    >
                      {p}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() =>
                            setPrefixes((prev) => prev.filter((x) => x !== p))
                          }
                          className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Remove ${p}`}
                          disabled={saveMutation.isPending}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              )}
              {canManage && (
                <div className="flex gap-1.5">
                  <Input
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addPrefix(draft);
                      }
                    }}
                    placeholder="e.g. project."
                    className="h-8 font-mono text-xs"
                    disabled={saveMutation.isPending}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => addPrefix(draft)}
                    disabled={!draft.trim() || saveMutation.isPending}
                  >
                    Add
                  </Button>
                </div>
              )}
              {error && <p className="text-[11px] text-destructive">{error}</p>}
            </div>

            {canManage && (
              <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                {hasBoundary ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setClearOpen(true)}
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                    disabled={clearMutation.isPending || saveMutation.isPending}
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    Clear boundary
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  className="gap-1.5"
                >
                  {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {hasBoundary ? 'Save boundary' : 'Apply boundary'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear permission boundary?"
        description="Removes the boundary entirely. All explicit allow-policies on this member will apply again at full strength."
        confirmLabel="Clear boundary"
        confirmVariant="destructive"
        isPending={clearMutation.isPending}
        onConfirm={() => clearMutation.mutate()}
      />
    </SectionCard>
  );
}
