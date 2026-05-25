'use client';

import { useTranslations } from 'next-intl';

/**
 * AccountSwitcher — the standalone "which account" switcher.
 *
 * The account is the workspace your projects live under, so it sits in the top
 * breadcrumb (Kortix / [Account]) rather than buried in a profile menu. It is
 * the symmetric sibling of <ProjectSwitcher>: same shape, two variants, backed
 * by the same current-account store.
 *  - `header`  — a compact pill in the top-bar breadcrumb.
 *  - `sidebar` — a full-width widget for shells that want it inline.
 *
 * It owns everything account-shaped: switch account, per-account settings,
 * billing, and create. Identity ("you") lives in the sibling <UserMenu>; the
 * default-selected-account guarantee lives there too (it's mounted app-wide).
 *
 * Account tiles use the design-system <EntityAvatar> (things are square).
 */

import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  CreditCard,
  Plus,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { isBillingEnabled } from '@/lib/config';
import { listAccounts, type KortixAccount } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { CreateAccountModal } from '@/components/accounts/create-account-modal';
import { AccountSettingsModal } from '@/components/settings/account-settings-modal';

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
  const queryClient = useQueryClient();
  const { selectedAccountId, setSelectedAccountId } = useCurrentAccountStore();
  const billingActive = isBillingEnabled();

  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);

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

  const sortedAccounts = useMemo(
    () =>
      [...(accountsQuery.data ?? [])].sort((a, b) =>
        (a.name || '').localeCompare(b.name || ''),
      ),
    [accountsQuery.data],
  );

  const showSearch = (accountsQuery.data?.length ?? 0) > 6;
  const filteredAccounts = useMemo(() => {
    if (!query.trim()) return sortedAccounts;
    const q = query.trim().toLowerCase();
    return sortedAccounts.filter((a) =>
      (a.name || '').toLowerCase().includes(q),
    );
  }, [sortedAccounts, query]);

  const close = () => setMenuOpen(false);
  const deferAfterClose = (fn: () => void) => {
    setMenuOpen(false);
    requestAnimationFrame(() => fn());
  };

  const switchAccount = (account: KortixAccount) => {
    setSelectedAccountId(account.account_id);
    close();
  };

  const label = activeAccount?.name || 'Account';
  const tile = (
    <EntityAvatar label={label} size={variant === 'header' ? 'xs' : 'sm'} />
  );

  const trigger =
    variant === 'header' ? (
      <button
        type="button"
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-foreground transition-colors',
          'hover:bg-muted/50 data-[state=open]:bg-muted/60',
          className,
        )}
        aria-label={tHardcodedUi.raw(
          'componentsLayoutAccountSwitcher.line137JsxAttrAriaLabelSwitchAccount',
        )}
      >
        {tile}
        <span className="max-w-40 truncate text-sm font-medium">{label}</span>
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground/50" />
      </button>
    ) : (
      <SidebarMenuButton
        size="lg"
        className={cn(
          'group/trigger relative h-auto gap-2 rounded-lg border border-transparent bg-transparent px-1.5 py-1',
          'hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent',
          'group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!px-0',
        )}
      >
        {tile}
        <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight text-foreground group-data-[collapsible=icon]:hidden">
          {label}
        </span>
        <ChevronsUpDown className="ml-auto size-3 shrink-0 text-muted-foreground/40 group-data-[collapsible=icon]:hidden" />
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
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={6}
        className={cn(
          'overflow-hidden rounded-2xl border-border/60 p-0',
          variant === 'sidebar'
            ? 'w-(--radix-dropdown-menu-trigger-width) shadow-none'
            : 'w-64',
        )}
      >
        {showSearch && (
          <div className="border-b border-border/40 px-2 py-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tHardcodedUi.raw(
                  'componentsLayoutAccountSwitcher.line190JsxAttrPlaceholderFindAccount',
                )}
                className="h-7 pl-7 pr-2 text-xs placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
        )}

        <div className="py-1.5">
          <div className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground/50">
            Account
          </div>
          <div className="max-h-[280px] overflow-y-auto px-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {accountsQuery.isLoading ? (
              <div className="space-y-1 py-1">
                {Array.from({ length: 2 }, (_, i) => (
                  <Skeleton key={i} className="h-8 rounded-md" />
                ))}
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground/60">
                {query.trim() ? 'No accounts match' : 'No accounts yet'}
              </div>
            ) : (
              filteredAccounts.map((account) => {
                const itemLabel = account.name || 'Account';
                const active = account.account_id === activeAccount?.account_id;
                return (
                  <DropdownMenuItem
                    key={account.account_id}
                    onSelect={() => switchAccount(account)}
                    className={cn(
                      'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-0',
                      active && 'bg-muted/60',
                    )}
                  >
                    <EntityAvatar label={itemLabel} size="xs" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">
                      {itemLabel}
                    </span>
                    {active && (
                      <Check className="size-3.5 shrink-0 text-foreground/70" />
                    )}
                  </DropdownMenuItem>
                );
              })
            )}
          </div>
        </div>

        <div className="h-px bg-border/40" />

        <div className="px-1 py-1">
          {activeAccount && (
            <DropdownMenuItem
              onSelect={() => {
                close();
                router.push(`/accounts/${activeAccount.account_id}`);
              }}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-0 [&_svg]:!text-muted-foreground/70"
            >
              <SettingsIcon className="size-3.5" />
              <span className="flex-1 truncate text-sm font-medium text-foreground/80">
                Account settings
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              close();
              router.push('/accounts');
            }}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-0 [&_svg]:!text-muted-foreground/70"
          >
            <ArrowUpRight className="size-3.5" />
            <span className="flex-1 truncate text-sm font-medium text-foreground/80">
              {tHardcodedUi.raw(
                'componentsLayoutAccountSwitcher.line277JsxTextAllAccounts',
              )}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => deferAfterClose(() => setCreateOpen(true))}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-0 [&_svg]:!text-muted-foreground/70"
          >
            <Plus className="size-3.5" />
            <span className="flex-1 truncate text-sm font-medium text-foreground/80">
              {tHardcodedUi.raw(
                'componentsLayoutAccountSwitcher.line286JsxTextNewAccount',
              )}
            </span>
          </DropdownMenuItem>
          {billingActive && (
            <DropdownMenuItem
              onSelect={() => deferAfterClose(() => setBillingOpen(true))}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 py-0 [&_svg]:!text-muted-foreground/70"
            >
              <CreditCard className="size-3.5" />
              <span className="flex-1 truncate text-sm font-medium text-foreground/80">
                Billing
              </span>
            </DropdownMenuItem>
          )}
        </div>
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
          queryClient.setQueryData<KortixAccount[]>(
            ['accounts'],
            (accounts) => {
              const current = accounts ?? [];
              return current.some(
                (item) => item.account_id === account.account_id,
              )
                ? current.map((item) =>
                    item.account_id === account.account_id ? account : item,
                  )
                : [account, ...current];
            },
          );
          void queryClient.invalidateQueries({ queryKey: ['accounts'] });
          setSelectedAccountId(account.account_id);
          void queryClient.invalidateQueries({
            queryKey: ['projects', account.account_id],
          });
          router.push('/projects');
        }}
      />
      <AccountSettingsModal
        open={billingOpen}
        onOpenChange={setBillingOpen}
        defaultTab="billing"
        returnUrl={
          typeof window !== 'undefined' ? window?.location?.href || '/' : '/'
        }
      />
    </>
  );
}
