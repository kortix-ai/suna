'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { Plus } from '@/features/icon/icons/plus';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { isAccountCreationRestricted, isBillingEnabled } from '@/lib/config';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { buildAccountSettingsHref } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { listAccounts, type KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircleSolid,
  CaretUpDownIcon as ChevronsUpDown,
  GearSixIcon as CogOneSolid,
  CreditCardIcon as CreditCardSolid,
  MagnifyingGlassIcon as Search,
} from '@phosphor-icons/react';

export function AccountSwitcher({ className }: { className?: string }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const billingActive = isBillingEnabled();
  const { data: adminRole } = useAdminRole();
  // Self-host: hide the "New account" dropdown item for non-admins when
  // account creation is restricted (see isAccountCreationRestricted()) —
  // the backend 403 (account_creation_restricted) remains the authoritative
  // gate either way.
  const canCreateAccount = !isAccountCreationRestricted() || Boolean(adminRole?.isAdmin);

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) setQuery('');
  }, [menuOpen]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });

  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  const canManageBilling = usePermission(activeAccount?.account_id, 'billing.write').allowed;

  const sortedAccounts = useMemo(
    () =>
      [...(accountsQuery.data ?? [])].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [accountsQuery.data],
  );

  const showSearch = (accountsQuery.data?.length ?? 0) > 6;
  const filteredAccounts = useMemo(() => {
    if (!query.trim()) return sortedAccounts;
    const q = query.trim().toLowerCase();
    return sortedAccounts.filter((a) => (a.name || '').toLowerCase().includes(q));
  }, [sortedAccounts, query]);

  const close = () => setMenuOpen(false);
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const onAccountsRoute = pathname?.startsWith('/accounts/') ?? false;

  // Warm the rows the user can reach from here. A row is not an anchor — it
  // also writes the selected account, and it must not navigate off any other
  // route — so the push stays, and the prefetch keeps it out of a cold RSC
  // fetch. Only while the menu is open, and only on /accounts/ where the push
  // actually fires.
  useEffect(() => {
    if (!menuOpen || !onAccountsRoute) return;
    for (const account of filteredAccounts) {
      router.prefetch(`/accounts/${account.account_id}`);
    }
  }, [menuOpen, onAccountsRoute, filteredAccounts, router]);

  // The create-account destination is a module constant, so warm it the moment
  // the modal opens — the push below runs after the create POST resolves.
  useEffect(() => {
    if (!createOpen) return;
    router.prefetch(PROJECT_LANDING_PATH);
  }, [createOpen, router]);

  const switchAccount = (account: KortixAccount) => {
    setSelectedAccountId(account.account_id);
    close();
    if (onAccountsRoute) {
      // nav-contract: prefetch-only — the row switches account first and only navigates while already under /accounts/.
      router.push(`/accounts/${account.account_id}`);
    }
  };

  const label = activeAccount?.name || 'Account';
  const tile = <EntityAvatar label={label} size="xs" />;

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className={cn('max-sm:gap-1 max-sm:px-1.5', className)}
      aria-label={tHardcodedUi.raw(
        'componentsLayoutAccountSwitcher.line137JsxAttrAriaLabelSwitchAccount',
      )}
    >
      {tile}
      <span className="max-w-40 truncate text-sm font-medium sm:inline">{label}</span>
      <ChevronsUpDown className="text-muted-foreground hidden size-3 shrink-0 lg:block" />
    </Button>
  );

  if (accountsQuery.isLoading && !activeAccount) {
    // Render nothing while accounts load. The breadcrumb logo + page
    // label carry the header on their own, so a skeleton chip between them just
    // reads as noise — collapse it so it's simply `[logo] [label]`.
    return null;
  }

  const dropdown = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
        {showSearch && (
          <div className="border-border/40 border-b px-2 py-2">
            <div className="relative">
              <Search className="text-muted-foreground/50 pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsLayoutAccountSwitcher.line190JsxAttrPlaceholderFindAccount',
                )}
                className="placeholder:text-muted-foreground/50 h-7 pr-2 pl-7 text-xs"
              />
            </div>
          </div>
        )}

        <DropdownMenuLabel>Account</DropdownMenuLabel>
        <div className="max-h-[280px] [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {accountsQuery.isLoading ? (
            <div className="space-y-1 py-1">
              {Array.from({ length: 2 }, (_, i) => (
                <Skeleton key={i} className="h-8 rounded-md" />
              ))}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-muted-foreground/60 px-2 py-3 text-xs">
              {query.trim() ? 'No accounts match' : 'No accounts yet'}
            </div>
          ) : (
            filteredAccounts.map((account) => {
              const itemLabel = account.name || 'Account';
              const active = account.account_id === activeAccount?.account_id;
              return (
                <DropdownMenuItem key={account.account_id} onSelect={() => switchAccount(account)}>
                  <EntityAvatar label={itemLabel} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm leading-tight font-medium">
                    {itemLabel}
                  </span>
                  {active && (
                    <CheckCircleSolid
                      weight="fill"
                      className="text-kortix-green size-3.5 shrink-0"
                    />
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </div>

        <DropdownMenuSeparator />

        {activeAccount && (
          <DropdownMenuItem asChild onSelect={close}>
            <Link href={`/accounts/${activeAccount.account_id}`} prefetch>
              <CogOneSolid weight="fill" className="size-3.5" />
              <span className="flex-1 truncate text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoFeaturesLayoutAccountSwitcherJsxTextAccountSettings2afa9a37',
                )}
              </span>
            </Link>
          </DropdownMenuItem>
        )}

        {/* <DropdownMenuItem
          onSelect={() => {
            close();
            router.push('/accounts');
          }}
        >
          <ArrowUpRight className="size-3.5" />
          <span className="flex-1 truncate text-sm font-medium">
            {tHardcodedUi.raw('componentsLayoutAccountSwitcher.line277JsxTextAllAccounts')}
          </span>
        </DropdownMenuItem> */}

        {canCreateAccount && (
          <DropdownMenuItem onSelect={() => deferAfterClose(() => setCreateOpen(true))}>
            <Plus className="size-3.5" />
            <span className="flex-1 truncate text-sm font-medium">
              {tHardcodedUi.raw('componentsLayoutAccountSwitcher.line286JsxTextNewAccount')}
            </span>
          </DropdownMenuItem>
        )}
        {billingActive && canManageBilling && (
          <DropdownMenuItem asChild onSelect={close}>
            <Link
              href={buildAccountSettingsHref({
                tab: 'billing',
                accountId: activeAccount?.account_id ?? null,
              })}
              prefetch
            >
              <CreditCardSolid weight="fill" className="size-3.5" />
              <span className="flex-1 truncate text-sm font-medium">Billing</span>
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {dropdown}

      <CreateAccountModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(account: KortixAccount) => {
          queryClient.setQueryData<KortixAccount[]>(['accounts'], (accounts) => {
            const current = accounts ?? [];
            return current.some((item) => item.account_id === account.account_id)
              ? current.map((item) => (item.account_id === account.account_id ? account : item))
              : [account, ...current];
          });
          void queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
          // qk.projects.scope(): reaches every account's list (and the
          // accountless slot), the same reach the old bare projects-literal
          // prefix match had. Account creation is rare — over-invalidating
          // costs nothing measurable.
          void queryClient.invalidateQueries({
            queryKey: qk.projects.scope(),
          });
          // The landing door, NOT the remembered project: that cookie names a
          // project in the account being left. The door re-resolves the latest
          // project for the account just switched to.
          // nav-contract: prefetch-only — fires after the create-account POST resolves; prefetched when the modal opens.
          router.push(PROJECT_LANDING_PATH);
        }}
      />
    </>
  );
}
