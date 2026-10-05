/**
 * The account screen: Members · Invites · Roles · Billing (SPEC §5.9).
 *
 * The data half. Every read is a method on the one `kortix()` client wrapped in
 * a React Query, every write is one of that client's mutations, and nothing
 * here draws a cell — `<AccountView/>` owns pixels and keys (same split as
 * `features/sidebar`).
 *
 * Billing is READ ONLY by design. `kortix.billing` exposes checkout and portal
 * mutations, and the TUI calls neither: a card flow belongs in a browser, so
 * `u` prints the web URL and stops there.
 */

import { webDashboardUrl } from '@kortix/cli/src/web-url.ts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { hostOrigin } from '../../auth/hosts.ts';
import { hostInfo, kortix } from '../../kortix.ts';
import {
  type AccountTab,
  AccountView,
  type BillingInput,
  type InviteInput,
  type InviteRole,
  type MemberInput,
  type RoleInput,
} from './account-view.tsx';

export interface AccountScreenProps {
  accountId: string;
  /** Only a focused screen answers keys. */
  focused: boolean;
  width: number;
  height: number;
  onBack(): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

/** Ages tick in minutes; recomputing faster only spends renders. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

/**
 * Where checkout actually lives.
 *
 * The account hub is a modal over whatever page you are on, addressed by query
 * params (`apps/web/src/stores/account-panel-store.ts`), so the URL is a real
 * page plus `?accountId=…&accountTab=billing`. `webDashboardUrl` maps the API
 * origin to the frontend origin — never string-munged here, because that guess
 * is wrong for a self-host stack on non-default ports.
 */
export function billingWebUrl(backendUrl: string, accountId: string): string {
  const dashboard = webDashboardUrl(hostOrigin(backendUrl));
  return `${dashboard}/projects?accountId=${accountId}&accountTab=billing`;
}

export function AccountScreen({
  accountId,
  focused,
  width,
  height,
  onBack,
  onToast,
}: AccountScreenProps) {
  const [tab, setTab] = useState<AccountTab>('members');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const host = hostInfo();
  const scope = [host?.name ?? '', host?.backendUrl ?? '', accountId] as const;

  const accountQuery = useQuery({
    queryKey: ['tui', 'account', ...scope],
    queryFn: () => kortix().accounts.get(accountId),
    enabled: Boolean(accountId),
  });

  const membersQuery = useQuery({
    queryKey: ['tui', 'account-members', ...scope],
    queryFn: () => kortix().accounts.members(accountId),
    enabled: Boolean(accountId),
  });

  const invitesQuery = useQuery({
    queryKey: ['tui', 'account-invites', ...scope],
    queryFn: () => kortix().accounts.invites(accountId),
    enabled: Boolean(accountId),
  });

  const rolesQuery = useQuery({
    queryKey: ['tui', 'account-roles', ...scope],
    queryFn: () => kortix().iam.roles.list(accountId),
    enabled: Boolean(accountId),
  });

  // `accountState` degrades gracefully to a "no plan" shape when billing is
  // disabled or the caller is unauthenticated, so it never needs a try/catch
  // for those two cases (see the SDK's `getAccountState`).
  const billingQuery = useQuery({
    queryKey: ['tui', 'account-billing', ...scope],
    queryFn: () => kortix().billing.accountState({ accountId }),
    enabled: Boolean(accountId),
  });

  const activeQuery =
    tab === 'members'
      ? membersQuery
      : tab === 'invites'
        ? invitesQuery
        : tab === 'roles'
          ? rolesQuery
          : billingQuery;

  const invite = useCallback(
    async (input: { email: string; role: InviteRole }) => {
      setBusy('inviting…');
      try {
        const result = await kortix().accounts.invite(accountId, {
          email: input.email,
          role: input.role,
        });
        await invitesQuery.refetch();
        await membersQuery.refetch();
        onToast?.(
          result.status === 'added'
            ? `${input.email} was already a user — added as ${result.account_role}.`
            : `Invited ${input.email} as ${input.role}.`,
        );
      } catch (error) {
        onToast?.(`Invite failed: ${errorText(error)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [accountId, invitesQuery.refetch, membersQuery.refetch, onToast],
  );

  const cancelInvite = useCallback(
    async (inviteId: string) => {
      setBusy('cancelling…');
      try {
        await kortix().accounts.cancelInvite(accountId, inviteId);
        await invitesQuery.refetch();
        onToast?.('Invite cancelled.');
      } catch (error) {
        onToast?.(`Cancel failed: ${errorText(error)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [accountId, invitesQuery.refetch, onToast],
  );

  const refresh = useCallback(() => {
    void accountQuery.refetch();
    void membersQuery.refetch();
    void invitesQuery.refetch();
    void rolesQuery.refetch();
    void billingQuery.refetch();
  }, [
    accountQuery.refetch,
    membersQuery.refetch,
    invitesQuery.refetch,
    rolesQuery.refetch,
    billingQuery.refetch,
  ]);

  return (
    <AccountView
      accountName={accountQuery.data?.name ?? ''}
      accountId={accountId}
      viewerRole={accountQuery.data?.role ?? ''}
      tab={tab}
      onTabChange={setTab}
      focused={focused}
      width={width}
      height={height}
      now={now}
      members={(membersQuery.data ?? []) as MemberInput[]}
      invites={(invitesQuery.data ?? []) as InviteInput[]}
      roles={(rolesQuery.data ?? []) as RoleInput[]}
      billing={(billingQuery.data ?? null) as BillingInput | null}
      loading={activeQuery.isLoading}
      errorMessage={activeQuery.isError ? errorText(activeQuery.error) : null}
      busyMessage={busy}
      billingUrl={billingWebUrl(host?.backendUrl ?? '', accountId)}
      onBack={onBack}
      onInvite={(input) => void invite(input)}
      onCancelInvite={(inviteId) => void cancelInvite(inviteId)}
      canCancelInvite={typeof kortix().accounts.cancelInvite === 'function'}
      onRefresh={refresh}
      onToast={onToast}
    />
  );
}
