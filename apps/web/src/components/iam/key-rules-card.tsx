'use client';

/**
 * The workspace's key rules — what `pat-policy-card.tsx` used to call "CLI
 * token lifecycle".
 *
 * Same three fields, same endpoint (`GET`/`PATCH
 * /accounts/{id}/iam/pat-policy`), rewritten so a person who has never heard
 * the words "PAT" or "mint" can set them:
 *
 * | Was                                            | Now                        |
 * | ---------------------------------------------- | -------------------------- |
 * | "Require expiry on every PAT" / "the mint endpoint refuses PATs without an `expires_at`" | "Require an end date" / "New keys can't be created without one." |
 * | "Max lifetime (days)" / "Refuses PATs whose requested expires_at is further out than…"   | "Longest a key can last" |
 * | "Idle auto-revoke (days)" / "auto-revoked on the next sign-in attempt"                    | "Turn off unused keys" |
 *
 * Two things changed beyond the words. The toggle is the design system's
 * `Switch`, not a raw `<input type="checkbox">` — that checkbox was the only
 * one of its kind left in the settings panel. And the fields sit in a
 * `SettingsRowGroup`, the label-left/control-right shape every other pane on
 * this branch uses, instead of a two-column grid of stacked labels.
 *
 * The rules apply to keys people create. Session-injected keys are exempt
 * server-side (`repositories/account-tokens.ts` skips the policy when
 * `projectId` is set), which is why the description says so in plain words
 * rather than leaving an admin to discover it.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { type PatPolicy, getPatPolicy, updatePatPolicy } from '@/lib/iam-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Backend caps, mirrored here so the error arrives before the request does. */
const MAX_LIFETIME_DAYS = 365 * 2;
const MAX_IDLE_DAYS = 365;

type DaysField = { ok: true; value: number | null } | { ok: false; error: string };

/** Blank means "no rule" — the field is optional, not invalid. */
export function parseDaysField(label: string, raw: string, max: number): DaysField {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `${label}: use a whole number of days, or leave it empty.` };
  }
  if (parsed > max) {
    return { ok: false, error: `${label}: ${max} days is the most Kortix allows.` };
  }
  return { ok: true, value: parsed };
}

function toField(value: number | null | undefined): string {
  return value == null ? '' : String(value);
}

/**
 * Identity of a saved policy, used as the form's React `key`.
 *
 * The old card seeded its three fields from a `useEffect` that fired on every
 * `query.data` change — the `react-hooks/set-state-in-effect` shape React 19
 * warns about, and a cascading render on every refetch. Mounting the form
 * under a key derived from the saved values does the same job with no effect
 * at all: local edits leave the key alone, and a save (or any refetch that
 * returns different values) changes it, which remounts the form seeded from
 * the server. Every field is in the key, so a change to any one of them
 * re-seeds.
 */
export function policyIdentity(policy: PatPolicy): string {
  return [policy.require_expiry, policy.max_lifetime_days, policy.idle_revoke_days].join('|');
}

export interface KeyRulesCardProps {
  accountId: string;
  /** `account.write` — the whole form is read-only without it. */
  canManage: boolean;
}

export function KeyRulesCard({ accountId, canManage }: KeyRulesCardProps) {
  const query = useQuery({
    queryKey: ['iam-pat-policy', accountId],
    queryFn: () => getPatPolicy(accountId),
    staleTime: 30_000,
  });

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title="Key rules"
        description="Applies to keys people create here. Keys Kortix creates for a running session end with that session."
      />

      {query.isLoading ? (
        <Skeleton className="h-40 w-full rounded-md" />
      ) : query.isError || !query.data ? (
        <ErrorState
          size="sm"
          title="Couldn't load the key rules"
          description={query.error instanceof Error ? query.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <KeyRulesForm
          key={policyIdentity(query.data)}
          accountId={accountId}
          canManage={canManage}
          policy={query.data}
        />
      )}
    </section>
  );
}

function KeyRulesForm({
  accountId,
  canManage,
  policy,
}: {
  accountId: string;
  canManage: boolean;
  policy: PatPolicy;
}) {
  const queryClient = useQueryClient();
  const [requireExpiry, setRequireExpiry] = useState(policy.require_expiry);
  const [maxLifetime, setMaxLifetime] = useState(toField(policy.max_lifetime_days));
  const [idleRevoke, setIdleRevoke] = useState(toField(policy.idle_revoke_days));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (patch: Partial<PatPolicy>) => updatePatPolicy(accountId, patch),
    onSuccess: () => {
      successToast('Key rules saved');
      queryClient.invalidateQueries({ queryKey: ['iam-pat-policy', accountId] });
      setError(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Could not save the key rules'),
  });

  const dirty =
    policy.require_expiry !== requireExpiry ||
    toField(policy.max_lifetime_days) !== maxLifetime.trim() ||
    toField(policy.idle_revoke_days) !== idleRevoke.trim();

  function save() {
    // The labels are the row labels verbatim, so the message points at a
    // control the reader can see.
    const lifetime = parseDaysField('Longest a key can last', maxLifetime, MAX_LIFETIME_DAYS);
    if (!lifetime.ok) {
      setError(lifetime.error);
      return;
    }
    const idle = parseDaysField('Turn off unused keys', idleRevoke, MAX_IDLE_DAYS);
    if (!idle.ok) {
      setError(idle.error);
      return;
    }
    setError(null);
    mutation.mutate({
      require_expiry: requireExpiry,
      max_lifetime_days: lifetime.value,
      idle_revoke_days: idle.value,
    });
  }

  const disabled = !canManage || mutation.isPending;

  return (
    <>
      <SettingsRowGroup>
        <SettingsRow
          label="Require an end date"
          description="New keys can't be created without one."
        >
          <Switch
            checked={requireExpiry}
            onCheckedChange={setRequireExpiry}
            disabled={disabled}
            aria-label="Require an end date"
          />
        </SettingsRow>
        <SettingsRow
          label="Longest a key can last"
          description="The furthest ahead an end date can be set."
        >
          <Input
            value={maxLifetime}
            onChange={(event) => setMaxLifetime(event.target.value)}
            placeholder="No limit"
            inputMode="numeric"
            disabled={disabled}
            variant="popover"
            className="h-8 w-28 tabular-nums"
            aria-label="Longest a key can last, in days"
          />
          <span className="text-muted-foreground text-xs">days</span>
        </SettingsRow>
        <SettingsRow
          label="Turn off unused keys"
          description="A key nobody has used for this long stops working."
        >
          <Input
            value={idleRevoke}
            onChange={(event) => setIdleRevoke(event.target.value)}
            placeholder="Never"
            inputMode="numeric"
            disabled={disabled}
            variant="popover"
            className="h-8 w-28 tabular-nums"
            aria-label="Turn off unused keys after this many days"
          />
          <span className="text-muted-foreground text-xs">days</span>
        </SettingsRow>
      </SettingsRowGroup>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      {canManage ? (
        <div className="flex justify-end">
          {/* Only live once something has actually changed — a Save that is
              always enabled invites a pointless PATCH and reads as unsaved
              work when there is none. */}
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}
