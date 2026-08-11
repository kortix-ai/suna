'use client';

/**
 * The Organization → General tab (JAY-546) — a NEW 27th tab, id
 * `organization`, label "General", placed first in the Organization group
 * (before Billing). This is deliberately a separate tab from Workspace →
 * General (`tabs/general-tab.tsx`): folding this content in there would put
 * two scopes and two danger zones (delete workspace AND delete organization)
 * on one page — Jay's call, 2026-08-10, settled, not reopened here.
 *
 * **Source — mount, do not reimplement.** The live pane is
 * `app/(app)/accounts/[id]/page.tsx:621-685`, four `SettingsGroup`s under
 * `activeSection === 'settings' && canWriteAccount`:
 *
 * | Order | Group | Contents | Extra gate |
 * | --- | --- | --- | --- |
 * | 1 | General | `GeneralCard` | — |
 * | 2 | Security | `MfaRequiredCard`, then an `Advanced` `Disclosure` (closed) wrapping `SessionControlsCard` | — |
 * | 3 | Enterprise features | `EnterpriseDemoCard` | `!entitlementsLoading && !accountStateQuery.data?.enterprise_license_available` |
 * | 4 | Danger zone | `DangerZoneCard` | `canDeleteAccount` |
 *
 * **Whole-tab gate.** `account.write` (`page.tsx:621`,
 * `activeSection === 'settings' && canWriteAccount`) — same leaf
 * `billing`/`usage`/`identity`/`api-keys` gate on. `ACCOUNT_TAB_PERMISSION`
 * in `settings-panel.tsx` carries `organization: 'account.write'`.
 *
 * **Two of the four cards are NOT reusable components — they never were.**
 * `MfaRequiredCard` (`@/components/iam/mfa-required-card`) and
 * `SessionControlsCard` (`@/components/iam/session-controls-card`) are real,
 * exported, self-contained components (own `useQuery`/`useMutation`, take
 * only `{ accountId, canManage }`) — mounted here UNMODIFIED through
 * `mfaSlot`/`sessionControlsSlot`, same slot reasoning as
 * `api-keys-tab.tsx`'s `patPolicySlot`. `EnterpriseDemoCard`
 * (`@/components/iam/enterprise-demo-card`) is the same shape, mounted
 * through `enterpriseSlot`.
 *
 * `GeneralCard` and `DangerZoneCard`, by contrast, are `function GeneralCard`
 * / `function DangerZoneCard` declared directly inside `page.tsx` (lines 915
 * and 985) with NO `export` keyword — confirmed:
 * `grep -n "^export function GeneralCard\|^export function DangerZoneCard"
 * "src/app/(app)/accounts/[id]/page.tsx"` returns nothing. They cannot be
 * imported. `OrganizationGeneralCard` below reproduces `GeneralCard`'s
 * behavior (fetch the account, rename form, `updateAccountName` mutation,
 * "Created {date}" footer) as a new, self-contained component with the same
 * `{ accountId, canManage }` shape as the three real slots above — this is
 * new code, not a copy of unreachable source, so it is not one of the "do
 * not modify" cards. The danger-zone row is reproduced directly in
 * `OrganizationTabView` (no slot — it has no hooks, same as
 * `DangerZoneCard` itself): same "Delete account" copy, same disabled
 * "Coming soon" button — there is no `deleteAccount` REST function exported
 * anywhere in `@kortix/sdk` (checked: `grep -rn "export.*function
 * deleteAccount\b\|export const deleteAccount\b" packages/sdk/src` returns
 * nothing; the only `deleteAccount\b` hits in the whole repo are this
 * comment and unrelated i18n keys in `apps/web/src/features/accounts/
 * settings/general-tab.tsx`'s OWN "delete account" copy, a different,
 * user-scoped self-serve deletion surface, not this account/organization
 * one), so inventing a working delete here would be a button that silently
 * does nothing — the same principle `connected-tab.tsx`'s
 * Claude Code row and `profile-tab.tsx`'s original delete-account gate were
 * held to.
 *
 * **This task closes JAY-505's orphans for `MfaRequiredCard`,
 * `SessionControlsCard`, and `EnterpriseDemoCard`** — all three were mounted
 * only on the page JAY-505 deletes. Verified before wiring the slots below:
 * `grep -rn "MfaRequiredCard\b" src --include="*.tsx" | grep -v test`,
 * `grep -rn "SessionControlsCard\b" src --include="*.tsx" | grep -v test`,
 * and `grep -rn "EnterpriseDemoCard\b" src --include="*.tsx" | grep -v test`
 * each returned exactly two non-test hits at the time this file was written:
 * the import + JSX mount inside `app/(app)/accounts/[id]/page.tsx` (lines
 * 35/637, 42/652, and 30/674 respectively) and the component's own
 * `export function` line in `src/components/iam/*-card.tsx`. This file adds
 * a second live mount for each (`mfaSlot`/`sessionControlsSlot`/
 * `enterpriseSlot` below), so re-running the same three greps after this
 * change shows a third hit apiece, right here — none goes unreachable once
 * `app/(app)/accounts/[id]/page.tsx` is deleted (JAY-505). None of the three
 * card files themselves is modified.
 *
 * **The Advanced disclosure stays closed by default — do not promote it.**
 * `page.tsx:631-635`'s comment: MFA is the one control most accounts touch;
 * session lifetime and idle timeout are compliance-shop noise. `Disclosure`
 * (`@/components/ui/disclosure`) defaults `open` to `false` when no `open`
 * prop is passed (`disclosure.tsx:90`), so `sessionControlsSlot` renders
 * inside `DisclosureContent`, whose children are gated on `{open && …}`
 * (`disclosure.tsx:206`) — under `renderToStaticMarkup` with the trigger
 * label present and no slot content, exactly the state this file's test
 * pins.
 *
 * **The Enterprise group's gate is a NEGATIVE condition — reproduced as-is,
 * not simplified.** `page.tsx:669`:
 * `!entitlementsLoading && !accountStateQuery.data?.enterprise_license_available`.
 * When a self-host operator's Enterprise licence already forces every
 * entitlement on, there is nothing left to demo-toggle, so the group hides
 * entirely — do not invert this to a positive "show when license
 * unavailable" branch written differently from the source; the two negations
 * stay two negations here (`enterpriseVisible` below is computed the exact
 * same way). `entitlementsLoading` follows `identity-tab.tsx`/
 * `audit-tab.tsx`'s established extension of the source's own
 * `!entitlements && accountStateQuery.isLoading`
 * (`page.tsx:310`) with the `authLoading`/`!resolvedAccountId` race guard
 * those two files already document — same reasoning, not re-derived.
 *
 * **Danger zone gate — its own probe, never re-derived.** `canDeleteAccount`
 * is `account.delete` (`page.tsx:324`,`:681`), a DIFFERENT leaf from the
 * whole-tab `account.write` gate. `OrganizationTabInner` below probes it
 * with its own `usePermission(resolvedAccountId, 'account.delete')` call —
 * reusing `canWriteAccount` here (both are booleans in scope, both often
 * true for the same admin) would silently widen who can see the "Delete
 * account" row to every account.write holder instead of only
 * account.delete holders, the exact class of mistake this task's brief
 * calls out from an earlier task's review.
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * **Do not fetch on mount.** `SettingsTabPane` in `settings-panel.tsx` gates
 * on `if (!active) return null;` — `OrganizationTab`'s hooks (and every
 * slot's own fetch) only ever run while this tab is the active one.
 *
 * `OrganizationTabView` is the pure, props-only half — no hooks, no data
 * fetching, no store or Supabase read. It only ever exercises the
 * `enterpriseVisible`/`canDeleteAccount` axes and the disclosure's own
 * default-closed behavior — the `account.write` whole-tab gate lives in
 * `OrganizationTabInner` (the container), which can't render under
 * `renderToStaticMarkup` with no providers mounted — same split as every
 * other Phase 3 tab.
 *
 * **Untestable here, by design (see the task brief's constraints).** The
 * rename mutation, the MFA toggle, the session-policy save/revoke, and the
 * enterprise-demo toggle all need a live network and a real DOM. `bun test`
 * has no DOM. `organization-tab.test.tsx` covers what the pure view can
 * prove statically: group order, the closed-by-default disclosure, the
 * Enterprise negative gate, and the danger zone's own gate.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { EnterpriseDemoCard } from '@/components/iam/enterprise-demo-card';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { SessionControlsCard } from '@/components/iam/session-controls-card';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccount, getAccountState, updateAccountName, type AccountState } from '@kortix/sdk';
import { CaretDownIcon as ChevronDown } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

/** Byte-identical to `app/(app)/accounts/[id]/page.tsx`'s own local
 *  `formatDate` (lines 231-238), which is not exported — duplicated the same
 *  way `members-tab.tsx` and `profile-tab.tsx` each keep their own local copy
 *  rather than reaching for `lib/utils/date.ts`'s `formatDate` (different
 *  fallback string, different locale argument — not the same function). */
function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface OrganizationTabViewProps {
  /** `OrganizationGeneralCard` below — owns its own `useQuery`/`useMutation`,
   *  so it's a slot, same reasoning as every other real-data card here. Left
   *  `undefined` by default so the bare view still renders under
   *  `renderToStaticMarkup` with no providers. */
  generalSlot?: ReactNode;
  /** `MfaRequiredCard`, mounted unmodified — see this file's header comment. */
  mfaSlot?: ReactNode;
  /** `SessionControlsCard`, mounted unmodified inside the closed-by-default
   *  Advanced disclosure — see this file's header comment. */
  sessionControlsSlot?: ReactNode;
  /** `!entitlementsLoading && !accountStateQuery.data?.enterprise_license_available`
   *  — the Enterprise group's own negative gate, reproduced exactly. See this
   *  file's header comment. */
  enterpriseVisible?: boolean;
  /** `EnterpriseDemoCard`, mounted unmodified — see this file's header comment. */
  enterpriseSlot?: ReactNode;
  /** `account.delete` — the Danger zone's OWN gate, a different leaf from the
   *  whole-tab `account.write` gate. See this file's header comment. */
  canDeleteAccount?: boolean;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `OrganizationTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `ApiKeysTabView`/`AuditTabView` for the same split. Does NOT encode the
 *  `account.write` whole-tab gate — that lives in `OrganizationTabInner`, see
 *  this file's header comment. */
export function OrganizationTabView({
  generalSlot,
  mfaSlot,
  sessionControlsSlot,
  enterpriseVisible = false,
  enterpriseSlot,
  canDeleteAccount = false,
}: OrganizationTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="organization" />
      <div className="space-y-10">
        {/* 1. General — page.tsx:623-629, no extra gate. No section heading:
            the pane heading right above already reads "General" (this tab's
            own rail label), and a second "General" directly under it would
            repeat the same word — see `settings-tab-header.tsx`. */}
        <section className="space-y-4">{generalSlot}</section>

        {/* 2. Security — page.tsx:636-659, no extra gate. MFA is primary;
            session lifetime/idle timeout hide under the closed-by-default
            Advanced disclosure. */}
        <section className="space-y-4">
          <SettingsSubsectionHeader
            title="Security"
            description="Account-wide sign-in requirements."
          />
          <div className="space-y-3">
            {mfaSlot}
            <Disclosure variant="outline" className="group bg-popover overflow-hidden">
              <DisclosureTrigger className="px-4 py-3">
                <div className="flex w-full cursor-pointer items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">Advanced</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Session lifetime and idle timeout.
                    </p>
                  </div>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </DisclosureTrigger>
              <DisclosureContent contentClassName="border-border border-t">
                <div className="px-4 py-5">{sessionControlsSlot}</div>
              </DisclosureContent>
            </Disclosure>
          </div>
        </section>

        {/* 3. Enterprise features — page.tsx:661-679. Negative gate,
            reproduced exactly, see this file's header comment. */}
        {enterpriseVisible ? (
          <section className="space-y-4">
            <SettingsSubsectionHeader
              title="Enterprise features"
              description="Preview SSO, SCIM, advanced RBAC, and audit logs before upgrading."
            />
            {enterpriseSlot}
          </section>
        ) : null}

        {/* 4. Danger zone — page.tsx:681-685, gated on account.delete
            (canDeleteAccount), a different leaf from the whole-tab gate. No
            slot: same as source's DangerZoneCard, this row has no hooks. */}
        {canDeleteAccount ? (
          <section className="space-y-4">
            <SettingsSubsectionHeader title="Danger zone" />
            <div className="bg-popover rounded-md border px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-foreground text-sm font-medium">Delete account</p>
                  <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                    Permanently deletes this account and all its projects.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled
                  title="Coming soon"
                  className="shrink-0"
                >
                  Coming soon
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Reproduces `page.tsx`'s local, non-exported `GeneralCard` (rename form +
 *  "Created {date}" footer, `updateAccountName` mutation) as a new,
 *  self-contained component — see this file's header comment for why it
 *  can't be imported. Owns its own account fetch, same `{ accountId,
 *  canManage }` shape as `MfaRequiredCard`/`SessionControlsCard`/
 *  `EnterpriseDemoCard` above, so it composes the same way through a slot. */
function OrganizationGeneralCard({
  accountId,
  canManage,
}: {
  accountId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId),
    staleTime: 30_000,
  });
  const account = accountQuery.data;

  const [name, setName] = useState(account?.name ?? '');

  useEffect(() => {
    if (account) setName(account.name);
  }, [account?.name]);

  const renameMutation = useMutation({
    mutationFn: (next: string) => updateAccountName(accountId, next),
    onSuccess: (updated) => {
      successToast('Account updated');
      queryClient.setQueryData(['account', accountId], updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update account'),
  });

  if (accountQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn't load account"
        description={accountQuery.error instanceof Error ? accountQuery.error.message : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => accountQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (accountQuery.isLoading || !account) {
    return <Skeleton className="h-[86px] w-full rounded-md" />;
  }

  const trimmed = name.trim();
  const canSubmit = canManage && trimmed.length > 0 && trimmed !== account.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    renameMutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-popover rounded-md border">
      <div className="space-y-1.5 px-4 py-5">
        <Label htmlFor="organization-account-name">Account name</Label>
        <Input
          id="organization-account-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canManage || renameMutation.isPending}
          maxLength={120}
          className="max-w-md"
          title={canManage ? undefined : 'You do not have permission to rename this account.'}
        />
        {!canManage ? (
          <p className="text-muted-foreground text-xs">
            You do not have permission to rename this account.
          </p>
        ) : null}
      </div>

      <div className="border-border flex items-center justify-between border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">Created {formatDate(account.created_at)}</p>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || renameMutation.isPending}
          className="gap-1.5"
        >
          {renameMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `OrganizationTabInner` so every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function OrganizationTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <OrganizationTabInner accountId={resolvedAccountId} />;
}

function OrganizationTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const { session, isLoading: authLoading } = useAuth();

  // account.write — the whole-tab gate (see this file's header comment),
  // same leaf billing-tab.tsx/usage-tab.tsx/identity-tab.tsx/api-keys-tab.tsx
  // probe for their own whole-tab gate.
  const { allowed: canWriteAccount } = usePermission(resolvedAccountId, 'account.write');
  // account.delete — the Danger zone's OWN gate. A SEPARATE probe from
  // canWriteAccount above — never re-derived from it. See this file's header
  // comment.
  const { allowed: canDeleteAccount } = usePermission(resolvedAccountId, 'account.delete');

  const { data: accountState, isLoading: isLoadingAccountState } = useQuery<AccountState>({
    queryKey: accountStateKeys.state(resolvedAccountId),
    queryFn: () => getAccountState({ accountId: resolvedAccountId }),
    // Only fetch entitlements once we know the viewer can even see this pane
    // — a member without account.write never needs this query.
    enabled: !!resolvedAccountId && canWriteAccount && !!session && !authLoading,
    staleTime: 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const entitlements = accountState?.tier?.entitlements;
  const entitlementsLoading =
    !entitlements && (isLoadingAccountState || authLoading || !resolvedAccountId);
  // The Enterprise group's own negative gate — reproduced exactly, not
  // simplified. See this file's header comment.
  const enterpriseVisible = !entitlementsLoading && !accountState?.enterprise_license_available;

  // Whole-tab gate — account.write. Placed after every hook above so the
  // hook count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner/AuditTabInner's own whole-tab gates).
  if (!canWriteAccount) return null;

  return (
    <OrganizationTabView
      generalSlot={
        resolvedAccountId ? (
          <OrganizationGeneralCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      mfaSlot={
        resolvedAccountId ? (
          <MfaRequiredCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      sessionControlsSlot={
        resolvedAccountId ? (
          <SessionControlsCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      enterpriseVisible={enterpriseVisible}
      enterpriseSlot={
        resolvedAccountId ? (
          <EnterpriseDemoCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      canDeleteAccount={canDeleteAccount}
    />
  );
}
