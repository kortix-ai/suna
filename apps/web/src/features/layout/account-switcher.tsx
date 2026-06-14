'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateAccountModal } from '@/features/accounts/create-account-modal';
import { isBillingEnabled } from '@/lib/config';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';
import { usePermission } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { useAccountSettingsModalStore } from '@/stores/account-settings-modal-store';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  ArrowUpRight,
  CheckCircleSolid,
  ChevronsUpDown,
  CogOneSolid,
  CreditCardSolid,
  Search,
} from '@mynaui/icons-react';
import { Icon } from '../icon/icon';

export type AccountSwitcherVariant = 'header' | 'sidebar';

export function AccountSwitcher({
  variant = 'header',
  className,
}: {
  variant?: AccountSwitcherVariant;
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const billingActive = isBillingEnabled();

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

  const switchAccount = (account: KortixAccount) => {
    setSelectedAccountId(account.account_id);
    close();
    if (pathname?.startsWith('/accounts/')) {
      router.push(`/accounts/${account.account_id}`);
    }
  };

  const label = activeAccount?.name || 'Account';
  const tile = <EntityAvatar label={label} size={variant === 'header' ? 'xs' : 'sm'} />;

  const trigger =
    variant === 'header' ? (
      <Button
        variant="ghost"
        size="sm"
        className={cn('max-sm:gap-1 max-sm:px-1.5', className)}
        aria-label={tHardcodedUi.raw(
          'componentsLayoutAccountSwitcher.line137JsxAttrAriaLabelSwitchAccount',
        )}
      >
        {tile}
        <span className="  max-w-40 truncate text-sm font-medium sm:inline">{label}</span>
        <ChevronsUpDown className="text-muted-foreground hidden size-3 shrink-0 lg:block" />
      </Button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/trigger relative h-auto gap-2 rounded-2xl border border-transparent bg-transparent px-1.5 py-1',
          'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!px-0',
        )}
      >
        {tile}
        <span className="text-foreground min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <ChevronsUpDown className="text-muted-foreground/40 ml-auto size-3 shrink-0 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    );

  if (accountsQuery.isLoading && !activeAccount) {
    return variant === 'header' ? (
      <Skeleton className={cn('h-8 w-36 rounded-md', className)} />
    ) : (
      <Skeleton className="h-9 w-full rounded-lg" />
    );
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
                  {active && <CheckCircleSolid className="text-kortix-green size-3.5 shrink-0" />}
                </DropdownMenuItem>
              );
            })
          )}
        </div>

        <DropdownMenuSeparator />

        {activeAccount && (
          <DropdownMenuItem
            onSelect={() => {
              close();
              router.push(`/accounts/${activeAccount.account_id}`);
            }}
            // className="[&_svg]:!text-muted-foreground/70 flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-0"
          >
            <CogOneSolid className="size-3.5" />
            <span className="flex-1 truncate text-sm font-medium">Account settings</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onSelect={() => {
            close();
            router.push('/accounts');
          }}
        >
          <ArrowUpRight className="size-3.5" />
          <span className="flex-1 truncate text-sm font-medium">
            {tHardcodedUi.raw('componentsLayoutAccountSwitcher.line277JsxTextAllAccounts')}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => deferAfterClose(() => setCreateOpen(true))}>
          <Icon.Plus className="size-3.5" />
          <span className="flex-1 truncate text-sm font-medium">
            {tHardcodedUi.raw('componentsLayoutAccountSwitcher.line286JsxTextNewAccount')}
          </span>
        </DropdownMenuItem>
        {billingActive && canManageBilling && (
          <DropdownMenuItem
            onSelect={() =>
              deferAfterClose(() =>
                useAccountSettingsModalStore.getState().openAccountSettings({ tab: 'billing' }),
              )
            }
          >
            <CreditCardSolid className="size-3.5" />
            <span className="flex-1 truncate text-sm font-medium">Billing</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {variant === 'sidebar' ? (
        <SidebarMenu>
          <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center">
            {dropdown}
          </SidebarMenuItem>
        </SidebarMenu>
      ) : (
        dropdown
      )}

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
          void queryClient.invalidateQueries({
            queryKey: ['projects', account.account_id],
          });
          router.push('/projects');
        }}
      />
    </>
  );
}
