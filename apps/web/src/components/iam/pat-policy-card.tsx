'use client';

// PAT lifecycle policy on the Settings tab. Caps how long a CLI Personal
// Access Token can live, requires expiry on every mint, and auto-revokes
// idle tokens. Project-scoped tokens (sandbox-injected) are exempt.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorToast, successToast } from '@/components/ui/toast';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type PatPolicy,
  getPatPolicy,
  updatePatPolicy,
} from '@/lib/iam-client';

const MAX_LIFETIME = 365 * 2;
const MAX_IDLE = 365;

interface PatPolicyCardProps {
  accountId: string;
  canManage: boolean;
}

export function PatPolicyCard({ accountId, canManage }: PatPolicyCardProps) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['iam-pat-policy', accountId],
    queryFn: () => getPatPolicy(accountId),
    staleTime: 30_000,
  });

  const [maxLifetime, setMaxLifetime] = useState('');
  const [idleRevoke, setIdleRevoke] = useState('');
  const [requireExpiry, setRequireExpiry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setMaxLifetime(query.data.max_lifetime_days?.toString() ?? '');
    setIdleRevoke(query.data.idle_revoke_days?.toString() ?? '');
    setRequireExpiry(query.data.require_expiry);
  }, [query.data]);

  function parseDays(label: string, raw: string, max: number): number | null | { err: string } {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0) {
      return { err: `${label} must be a positive integer or blank` };
    }
    if (n > max) return { err: `${label} cannot exceed ${max} days` };
    return n;
  }

  const mutation = useMutation({
    mutationFn: (patch: Partial<PatPolicy>) => updatePatPolicy(accountId, patch),
    onSuccess: () => {
      successToast('PAT policy updated');
      queryClient.invalidateQueries({ queryKey: ['iam-pat-policy', accountId] });
      setError(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update PAT policy'),
  });

  function handleSave() {
    const lifetime = parseDays('Max lifetime', maxLifetime, MAX_LIFETIME);
    if (typeof lifetime === 'object' && lifetime && 'err' in lifetime) {
      setError(lifetime.err);
      return;
    }
    const idle = parseDays('Idle revoke', idleRevoke, MAX_IDLE);
    if (typeof idle === 'object' && idle && 'err' in idle) {
      setError(idle.err);
      return;
    }
    setError(null);
    mutation.mutate({
      max_lifetime_days: lifetime as number | null,
      idle_revoke_days: idle as number | null,
      require_expiry: requireExpiry,
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">CLI token lifecycle</p>
        <p className="text-muted-foreground text-xs">
          Apply to Personal Access Tokens (CLI / programmatic clients). Sandbox-injected tokens
          are exempt — their lifetime is bound to the sandbox itself.
        </p>
      </div>

      <div className="bg-popover rounded-md border">
        <div className="space-y-5 px-4 py-5">
          {query.isLoading ? (
            <Skeleton className="h-32 w-full rounded-md" />
          ) : (
            <>
              <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={requireExpiry}
                  onChange={(e) => setRequireExpiry(e.target.checked)}
                  disabled={!canManage || mutation.isPending}
                  className="border-border accent-primary mt-0.5 size-3.5 rounded"
                />
                <span>
                  <span className="font-medium">Require expiry on every PAT</span>
                  <span className="text-muted-foreground block text-xs">
                    When on, the mint endpoint refuses PATs without an
                    <span className="font-mono"> expires_at</span>.
                  </span>
                </span>
              </label>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Max lifetime (days)</Label>
                  <Input
                    value={maxLifetime}
                    onChange={(e) => setMaxLifetime(e.target.value)}
                    placeholder="blank = no cap"
                    inputMode="numeric"
                    disabled={!canManage || mutation.isPending}
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    Refuses PATs whose requested expires_at is further out than this many days
                    from now.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Idle auto-revoke (days)</Label>
                  <Input
                    value={idleRevoke}
                    onChange={(e) => setIdleRevoke(e.target.value)}
                    placeholder="blank = never"
                    inputMode="numeric"
                    disabled={!canManage || mutation.isPending}
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    Tokens not used in this many days are auto-revoked on the next sign-in
                    attempt.
                  </p>
                </div>
              </div>

              {error && <p className="text-destructive text-xs">{error}</p>}
            </>
          )}
        </div>

        {canManage && !query.isLoading && (
          <div className="border-border flex items-center justify-end border-t px-4 py-3">
            <Button size="sm" onClick={handleSave} disabled={mutation.isPending} className="gap-1.5">
              {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
              Save policy
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
