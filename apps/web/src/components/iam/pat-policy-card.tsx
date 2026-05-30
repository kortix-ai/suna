'use client';

import { useTranslations } from 'next-intl';
// PAT lifecycle policy on the Settings tab. Caps how long a CLI Personal
// Access Token can live, requires expiry on every mint, and auto-revokes
// idle tokens. Project-scoped tokens (sandbox-injected) are exempt.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      toast.success('PAT policy updated');
      queryClient.invalidateQueries({ queryKey: ['iam-pat-policy', accountId] });
      setError(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update PAT policy'),
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
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          {tHardcodedUi.raw('componentsIamPatPolicyCard.line95JsxTextCLITokenLifecycle')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {tHardcodedUi.raw('componentsIamPatPolicyCard.line98JsxTextApplyToPersonalAccessTokensCLIProgrammaticClients')}</p>
      </header>

      <div className="space-y-5 px-6 py-5">
        {query.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={requireExpiry}
                onChange={(e) => setRequireExpiry(e.target.checked)}
                disabled={!canManage || mutation.isPending}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <span>
                <span className="font-medium">{tHardcodedUi.raw('componentsIamPatPolicyCard.line118JsxTextRequireExpiryOnEveryPAT')}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {tHardcodedUi.raw('componentsIamPatPolicyCard.line120JsxTextWhenOnTheMintEndpointRefusesPATsWithout')}<span className="font-mono"> expires_at</span>.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs">{tHardcodedUi.raw('componentsIamPatPolicyCard.line128JsxTextMaxLifetimeDays')}</Label>
                <Input
                  value={maxLifetime}
                  onChange={(e) => setMaxLifetime(e.target.value)}
                  placeholder={tHardcodedUi.raw('componentsIamPatPolicyCard.line132JsxAttrPlaceholderBlankNoCap')}
                  inputMode="numeric"
                  disabled={!canManage || mutation.isPending}
                />
                <p className="text-[11px] text-muted-foreground">
                  {tHardcodedUi.raw('componentsIamPatPolicyCard.line137JsxTextRefusesPATsWhoseRequestedExpiresAtIsFurther')}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{tHardcodedUi.raw('componentsIamPatPolicyCard.line142JsxTextIdleAutoRevokeDays')}</Label>
                <Input
                  value={idleRevoke}
                  onChange={(e) => setIdleRevoke(e.target.value)}
                  placeholder={tHardcodedUi.raw('componentsIamPatPolicyCard.line146JsxAttrPlaceholderBlankNever')}
                  inputMode="numeric"
                  disabled={!canManage || mutation.isPending}
                />
                <p className="text-[11px] text-muted-foreground">
                  {tHardcodedUi.raw('componentsIamPatPolicyCard.line151JsxTextTokensNotUsedInThisManyDaysAre')}</p>
              </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {canManage && (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {tHardcodedUi.raw('componentsIamPatPolicyCard.line168JsxTextSavePolicy')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
