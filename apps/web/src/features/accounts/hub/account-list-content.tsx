'use client';

/**
 * The account list — the pane the hub shows when no account is selected.
 *
 * It has no URL of its own: `?accountId=` with an empty value is the modal
 * open with no account chosen. Rows are `HubLink`s, so picking one is a
 * `replaceState` and a render.
 */

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useCreateAccountFlow } from '@/features/accounts/use-create-account-flow';
import { hubTarget } from '@/stores/account-panel-store';

import { HubLink } from './account-hub-location';
import { AccountPane } from './account-pane';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { type KortixAccount } from '@kortix/sdk';
import {
  CaretRightIcon as ChevronRight,
  PlusIcon as Plus,
  UsersIcon as Users,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useMemo } from 'react';

export function AccountListContent() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { user, isLoading: authLoading } = useAuth();
  const { selectedAccountId } = useCurrentAccountStore();
  // Inside the hub: the create lands on `/new` by replacing the entry the
  // modal pushed, so Back points where the person started.
  const { canCreateAccount, openCreateAccount, createAccountDialog } = useCreateAccountFlow({
    insideHub: true,
  });

  useSignedOutRedirect();

  const accountsQuery = useAccountsList();

  const sortedAccounts = useMemo(() => {
    const accounts = accountsQuery.data ?? [];
    return [...accounts].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [accountsQuery.data]);

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  return (
    <>
      <AccountPane
        title={tI18nComplete.raw('text8a7c8b67fe8b')}
        description={tI18nComplete.raw('textced79983aab8')}
        action={
          canCreateAccount ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={openCreateAccount}
            >
              <Plus className="size-4" />
              {tI18nComplete.raw('textb8773d75259e')}
            </Button>
          ) : undefined
        }
      >
        {accountsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[54px] w-full rounded-md" />
            ))}
          </div>
        ) : accountsQuery.isError ? (
          <ErrorState
            size="sm"
            title={tI18nComplete.raw('text3867abe1d888')}
            description={(accountsQuery.error as Error).message}
            action={
              <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>
                {tI18nComplete.raw('text942087cc2d41')}
              </Button>
            }
          />
        ) : sortedAccounts.length === 0 ? (
          <EmptyState
            icon={Users}
            size="sm"
            title={tI18nComplete.raw('text84a7e27178d9')}
            description={tI18nComplete.raw('textc3f9db93886b')}
            action={
              canCreateAccount ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={openCreateAccount}
                >
                  <Plus className="size-3.5" />
                  {tI18nComplete.raw('textb8773d75259e')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="space-y-2">
            {sortedAccounts.map((account) => (
              <AccountRow
                key={account.account_id}
                account={account}
                active={account.account_id === selectedAccountId}
              />
            ))}
          </ul>
        )}
      </AccountPane>

      {createAccountDialog}
    </>
  );
}

function AccountRow({ account, active }: { account: KortixAccount; active: boolean }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = account.name || 'Account';
  return (
    <li>
      {/* A real anchor — Cmd-click opens this page with the modal already on
          that account — whose plain click costs a `replaceState` and a render. */}
      <HubLink
        to={hubTarget(account.account_id)}
        className="group bg-popover hover:bg-accent flex w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-colors"
      >
        <EntityAvatar label={label} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-foreground truncate text-sm font-medium">{label}</span>
            {active && (
              <Badge variant="outline" size="sm" className="border-foreground/30 text-foreground">
                {tI18nComplete.raw('text92340695899b')}
              </Badge>
            )}
          </span>
          {account.account_role ? (
            <span className="text-muted-foreground block text-xs capitalize">
              {account.account_role}
            </span>
          ) : null}
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </HubLink>
    </li>
  );
}
