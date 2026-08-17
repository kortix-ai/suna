'use client';

/**
 * The Organization → General tab — the organization's name, its account-wide
 * sign-in rules, the enterprise preview, and deletion. A separate tab from
 * Workspace → General (`tabs/general-tab.tsx`) on purpose: folding them
 * together would put two scopes and two danger zones (delete workspace AND
 * delete organization) on one page — Jay's call, 2026-08-10, settled.
 *
 * **Layout: Linear's settings shape**, the same as `profile-tab.tsx` and
 * `general-tab.tsx`. Pane heading, then rows — label left, control right,
 * consecutive rows sharing ONE bordered box separated by hairlines
 * (`SettingsRowGroup` / `SettingsRow`, `components/ui/settings-row.tsx`).
 * Sections between groups are a plain small heading
 * (`SettingsSubsectionHeader`), not a card header.
 *
 * This pane used to be the odd one out in the panel. It stacked four
 * separately bordered boxes, each in a different shape: a form with its own
 * footer strip, a paragraph card, a hand-rolled `Disclosure` with a chevron,
 * and a danger row. Five things changed, and each replaced something that was
 * there before:
 *
 * - **The three IAM cards are rows now.** `MfaRequiredCard`,
 *   `SessionControlsCard`, and `EnterpriseDemoCard` each drew their own
 *   `bg-popover rounded-md border` box. Each returns bare `SettingsRow`s and
 *   is mounted inside a group here — see each file's own header comment.
 *   `key-rules-card.tsx` made the same move first.
 * - **The Advanced disclosure is gone.** It existed to hide session lifetime
 *   and idle timeout, which as full cards were genuinely too much for a pane
 *   most people open to rename something. As two rows they cost two lines, so
 *   there is nothing left to hide and one fewer shape to read.
 * - **No empty state.** `SessionControlsCard`'s "No sessions tracked yet"
 *   block, and the `<details>` holding a faded duplicate table of revoked
 *   sessions, are both gone. `AccountSessionsPanel` renders `null` when there
 *   is nothing live to sign out.
 * - **No dead "Coming soon" button.** There is still no `deleteAccount` in
 *   `@kortix/sdk` (checked: `rg "export (async )?function deleteAccount\b"
 *   packages/sdk/src` returns nothing), so the row says so in words and shows
 *   muted "Unavailable" text on the right — exactly what `profile-tab.tsx`
 *   does when a deployment cannot delete an account. A disabled destructive
 *   button invites a click that can never do anything.
 * - **The pane has a description.** It lives on the rail entry
 *   (`rail.ts`, `tab: 'organization'`), which is where `SettingsTabHeader`
 *   reads it from — the component cannot supply one.
 *
 * **Whole-tab gate.** `account.write`, the same leaf `billing`/`usage`/
 * `identity`/`api-keys` gate on; `ACCOUNT_TAB_PERMISSION` in
 * `settings-panel.tsx` carries `organization: 'account.write'`.
 *
 * **Danger zone gate — its own probe, never re-derived.** `canDeleteAccount`
 * is `account.delete`, a DIFFERENT leaf from the whole-tab `account.write`
 * gate. `OrganizationTabInner` probes it with its own
 * `usePermission(resolvedAccountId, 'account.delete')` call — reusing
 * `canWriteAccount` (both booleans in scope, both often true for the same
 * admin) would silently widen who sees the delete row to every `account.write`
 * holder.
 *
 * **The Enterprise group's gate is a NEGATIVE condition — reproduced as-is.**
 * `!entitlementsLoading && !accountState?.enterprise_license_available`. When
 * a self-host operator's Enterprise licence already forces every entitlement
 * on, there is nothing left to demo-toggle, so the group hides entirely. The
 * two negations stay two negations. `entitlementsLoading` follows
 * `identity-tab.tsx`/`audit-tab.tsx`'s established extension of the source's
 * own `!entitlements && accountStateQuery.isLoading` with the
 * `authLoading`/`!resolvedAccountId` race guard those two files document.
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * **Do not fetch on mount.** `SettingsTabPane` in `settings-panel.tsx` gates
 * on `if (!active) return null;` — `OrganizationTab`'s hooks (and every
 * slot's own fetch) only ever run while this tab is the active one.
 *
 * `OrganizationTabView` is the pure, props-only half — no hooks, no data
 * fetching, no store or Supabase read, so it renders under
 * `renderToStaticMarkup` with no providers mounted. The `account.write`
 * whole-tab gate lives in `OrganizationTabInner` (the container) — same split
 * as every other Phase 3 tab.
 *
 * **Untestable here, by design.** The rename mutation, the MFA toggle, the
 * session-policy save, the force-logout, and the enterprise-demo toggle all
 * need a live network and a real DOM. `bun test` has no DOM.
 * `organization-tab.test.tsx` covers what the pure view can prove statically:
 * section order, the Enterprise negative gate, and the danger zone's own gate.
 */

import { useState, type FormEvent, type ReactNode } from 'react';

import { EnterpriseDemoCard } from '@/components/iam/enterprise-demo-card';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { AccountSessionsPanel, SessionControlsCard } from '@/components/iam/session-controls-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { accountStateKeys } from '@/hooks/billing';
import { usePermission } from '@/lib/use-permission';
import { getAccount, getAccountState, updateAccountName, type AccountState } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

/** Byte-identical to the local `formatDate` several other tabs keep — a
 *  different fallback string and a different locale argument from
 *  `lib/utils/date.ts`'s, so not the same function. */
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return DATE_FORMATTER.format(d);
}

export interface OrganizationTabViewProps {
  /** No account id resolved yet. Renders shape-matched skeletons rather than
   *  three empty bordered boxes, which is what a group with an absent slot
   *  would otherwise be. */
  isLoading?: boolean;
  /** `OrganizationGeneralCard` — owns its own `useQuery`/`useMutation`, so it
   *  is a slot. It renders its OWN `SettingsRowGroup` (it is the whole
   *  section, not rows inside a shared one). Left `undefined` by default so
   *  the bare view still renders under `renderToStaticMarkup`. */
  generalSlot?: ReactNode;
  /** `MfaRequiredCard` — bare rows, mounted inside the Security group. */
  mfaSlot?: ReactNode;
  /** `SessionControlsCard` — bare rows, mounted inside the Security group
   *  directly under the MFA row. */
  sessionControlsSlot?: ReactNode;
  /** `AccountSessionsPanel` — its own section under Security, because a table
   *  cannot sit inside a row group. Renders nothing when no session is live. */
  sessionsSlot?: ReactNode;
  /** `!entitlementsLoading && !accountState?.enterprise_license_available` —
   *  the Enterprise group's own negative gate, reproduced exactly. */
  enterpriseVisible?: boolean;
  /** `EnterpriseDemoCard` — bare rows, mounted inside the Enterprise group. */
  enterpriseSlot?: ReactNode;
  /** `account.delete` — the Danger zone's OWN gate, a different leaf from the
   *  whole-tab `account.write` gate. */
  canDeleteAccount?: boolean;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Does NOT encode the `account.write` whole-tab gate; that lives in
 *  `OrganizationTabInner`. */
export function OrganizationTabView({
  isLoading = false,
  generalSlot,
  mfaSlot,
  sessionControlsSlot,
  sessionsSlot,
  enterpriseVisible = false,
  enterpriseSlot,
  canDeleteAccount = false,
}: OrganizationTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="organization" />

      {isLoading ? (
        <div className="space-y-8">
          <Skeleton className="h-[124px] rounded-md" />
          <Skeleton className="h-[186px] rounded-md" />
        </div>
      ) : (
        <>
          {/* 1. General — no section heading: the pane heading right above
              already reads "General" (this tab's own rail label), and a second
              "General" directly under it would repeat the same word. Same
              reasoning as `general-tab.tsx`'s own first group. */}
          {generalSlot}

          {/* 2. Security — MFA and the session policy in one group, because
              they are one decision: how hard it is to hold a session here. */}
          <section className="space-y-3">
            <SettingsSubsectionHeader
              title="Security"
              description="Sign-in rules for everyone in this organization."
            />
            <SettingsRowGroup>
              {mfaSlot}
              {sessionControlsSlot}
            </SettingsRowGroup>
          </section>
          {sessionsSlot}

          {/* 3. Enterprise features — negative gate, reproduced exactly. */}
          {enterpriseVisible ? (
            <section className="space-y-3">
              <SettingsSubsectionHeader
                title="Enterprise features"
                description="Try SSO, SCIM, advanced roles, and audit logs before you upgrade."
              />
              <SettingsRowGroup>{enterpriseSlot}</SettingsRowGroup>
            </section>
          ) : null}

          {/* 4. Danger zone — gated on account.delete, a different leaf from
              the whole-tab gate. */}
          {canDeleteAccount ? (
            <section className="space-y-3">
              <SettingsSubsectionHeader title="Danger zone" />
              <SettingsRowGroup>
                <SettingsRow
                  label="Delete organization"
                  description="Deleting an organization is not self-serve yet. Contact Kortix support and we will close it for you."
                >
                  {/* Muted text, not a disabled destructive button: there is no
                      delete endpoint to call, and a button that can never do
                      anything is worse than saying so. `profile-tab.tsx` shows
                      the same "Unavailable" for the same reason. */}
                  <span className="text-muted-foreground text-sm">Unavailable</span>
                </SettingsRow>
              </SettingsRowGroup>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The organization's name and creation date, as one group.
 *
 * Reproduces the rename form that `app/(app)/accounts/[id]/page.tsx` keeps as
 * a local, non-exported `GeneralCard` — it cannot be imported, so this is new
 * code with the same `{ accountId, canManage }` shape as the three IAM cards.
 *
 * Two changes from that source. The name field saves through a button that
 * appears only once the value is dirty (`profile-tab.tsx`'s Name row), rather
 * than a permanently-present Save in a card footer. And "Created {date}" is a
 * row, not footer text — a fact with a label, in the same left/right column as
 * everything else, instead of a caption glued to the bottom of a form.
 */
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

  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  // Sync the draft from the loaded name during render, not an effect — this is
  // React's documented pattern for "adjust state when an input changes"
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-state-based-on-a-prop-or-state-change).
  // Calling setState here bails out the in-progress render and re-runs
  // immediately, before the browser paints, so it never flashes the stale
  // draft. `nameTouched` guards it so a background refetch of the same query
  // can never clobber an edit in progress. Lifted verbatim from
  // `profile-tab.tsx`'s Name row, which hit this first.
  const [loadedName, setLoadedName] = useState<string | null>(null);
  if (account && !nameTouched && account.name !== loadedName) {
    setLoadedName(account.name);
    setName(account.name);
  }

  const renameMutation = useMutation({
    mutationFn: (next: string) => updateAccountName(accountId, next),
    onSuccess: (updated) => {
      setNameTouched(false);
      successToast('Organization renamed');
      queryClient.setQueryData(['account', accountId], updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to rename the organization'),
  });

  if (accountQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn't load this organization"
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
    return <Skeleton className="h-[124px] w-full rounded-md" />;
  }

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== account.name;
  const canSubmit = canManage && dirty;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    renameMutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit}>
      <SettingsRowGroup>
        <SettingsRow
          label="Organization name"
          description={
            canManage
              ? 'Shown in the organization switcher and anywhere this organization is listed.'
              : 'You do not have permission to rename this organization.'
          }
        >
          <Input
            id="organization-account-name"
            // The row label is a heading, not a `<label htmlFor>` — the control
            // carries its own accessible name. Same as `general-tab.tsx`.
            aria-label="Organization name"
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            disabled={!canManage || renameMutation.isPending}
            maxLength={120}
            // Not `variant="popover"`: the group around it is itself
            // `bg-popover`, so a popover-tinted input would vanish into it.
            className="h-8 w-56"
          />
          {canSubmit ? (
            <Button type="submit" size="sm" disabled={renameMutation.isPending}>
              {renameMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              Save
            </Button>
          ) : null}
        </SettingsRow>

        <SettingsRow label="Created">
          <span className="text-muted-foreground text-sm tabular-nums">
            {formatDate(account.created_at)}
          </span>
        </SettingsRow>
      </SettingsRowGroup>
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

  // account.write — the whole-tab gate, the same leaf
  // billing-tab.tsx/usage-tab.tsx/identity-tab.tsx/api-keys-tab.tsx probe for
  // their own.
  const { allowed: canWriteAccount } = usePermission(resolvedAccountId, 'account.write');
  // account.delete — the Danger zone's OWN gate. A SEPARATE probe from
  // canWriteAccount above, never re-derived from it. See this file's header.
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

  // Whole-tab gate — account.write. Placed after every hook above so the hook
  // count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner/AuditTabInner's own whole-tab gates).
  if (!canWriteAccount) return null;

  if (!resolvedAccountId) return <OrganizationTabView isLoading />;

  return (
    <OrganizationTabView
      generalSlot={
        <OrganizationGeneralCard accountId={resolvedAccountId} canManage={canWriteAccount} />
      }
      mfaSlot={<MfaRequiredCard accountId={resolvedAccountId} canManage={canWriteAccount} />}
      sessionControlsSlot={
        <SessionControlsCard accountId={resolvedAccountId} canManage={canWriteAccount} />
      }
      sessionsSlot={
        <AccountSessionsPanel accountId={resolvedAccountId} canManage={canWriteAccount} />
      }
      enterpriseVisible={enterpriseVisible}
      enterpriseSlot={
        <EnterpriseDemoCard accountId={resolvedAccountId} canManage={canWriteAccount} />
      }
      canDeleteAccount={canDeleteAccount}
    />
  );
}
