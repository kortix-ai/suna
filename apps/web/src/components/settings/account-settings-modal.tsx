'use client';

import { useTranslations } from 'next-intl';

/**
 * AccountSettingsModal — parallel to UserSettingsModal but scoped to
 * the currently-selected account. Houses Billing and Transactions today;
 * future account-level concerns (Members, Account info, etc.) will land
 * here as additional tabs.
 *
 * UserSettingsModal owns user preferences (theme, sounds, notifications,
 * shortcuts). This one owns money + people + the account itself.
 */

import * as React from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/utils';
import { cn } from '@/lib/utils';
import { getAccountTabs, type SettingsTabId } from '@/lib/menu-registry';
import { listAccounts } from '@/lib/projects-client';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import {
  BillingTab,
  TransactionsTab,
} from '@/components/settings/user-settings-modal';

type TabId = Extract<SettingsTabId, 'billing' | 'transactions'>;

interface Tab {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface AccountSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: TabId;
  returnUrl?: string;
}

export function AccountSettingsModal({
  open,
  onOpenChange,
  defaultTab = 'billing',
  returnUrl = typeof window !== 'undefined' ? window?.location?.href || '/' : '/',
}: AccountSettingsModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
    enabled: open,
  });

  const activeAccount =
    accountsQuery.data?.find((a) => a.account_id === selectedAccountId) ??
    accountsQuery.data?.[0] ??
    null;

  const accountLabel =
    activeAccount?.name || (activeAccount?.personal_account ? 'Personal' : 'Account');
  const roleLine = activeAccount?.personal_account
    ? 'Personal account'
    : activeAccount?.account_role
      ? `${activeAccount.account_role.charAt(0).toUpperCase()}${activeAccount.account_role.slice(1)} · Team`
      : 'Team account';

  const tabs: Tab[] = getAccountTabs(true)
    .filter((t) => t.id === 'billing' || t.id === 'transactions')
    .map((t) => ({ id: t.id as TabId, label: t.label, icon: t.icon }));

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'gap-0 p-0',
          isMobile
            ? 'fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none left-0 top-0'
            : 'max-h-[90vh] max-w-5xl overflow-hidden',
        )}
        hideCloseButton
      >
        <DialogTitle className="sr-only">{tHardcodedUi.raw('componentsSettingsAccountSettingsModal.line95JsxTextAccountSettings')}</DialogTitle>

        {isMobile ? (
          <div className="flex h-screen w-screen flex-col overflow-hidden">
            {/* Header */}
            <div className="flex-shrink-0 border-b border-border bg-background px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-semibold leading-tight">{tHardcodedUi.raw('componentsSettingsAccountSettingsModal.line103JsxTextAccountSettings')}</div>
                  <div className="truncate text-xs text-muted-foreground leading-tight">
                    {accountLabel} · {roleLine}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onOpenChange(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Tab strip */}
            <div className="flex-shrink-0 border-b border-border bg-background px-3 py-2.5">
              <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [&::-webkit-scrollbar]:hidden">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <Button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      variant={isActive ? 'subtle' : 'ghost'}
                      className={cn(
                        'flex flex-shrink-0 items-center gap-2 justify-start whitespace-nowrap',
                        !isActive && 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <span>{tab.label}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-x-hidden overflow-y-auto">
              <div className="w-full max-w-full">
                {activeTab === 'billing' && (
                  <BillingTab returnUrl={returnUrl} isActive={activeTab === 'billing'} />
                )}
                {activeTab === 'transactions' && <TransactionsTab />}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-[700px] flex-row">
            {/* Sidebar */}
            <div className="w-60 flex-shrink-0 border-r border-border bg-background p-4">
              <div className="mb-3 flex justify-start">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => onOpenChange(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Active-account header */}
              <div className="mb-4 px-3">
                {accountsQuery.isLoading ? (
                  <>
                    <Skeleton className="mb-1 h-4 w-24" />
                    <Skeleton className="h-3 w-32" />
                  </>
                ) : (
                  <>
                    <div className="truncate text-sm font-medium leading-tight">
                      {accountLabel}
                    </div>
                    <div className="truncate text-xs text-muted-foreground leading-tight">
                      {roleLine}
                    </div>
                  </>
                )}
              </div>

              {/* Tabs */}
              <div className="flex flex-col gap-0.5">
                <div className="px-3 pb-1.5">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    Account
                  </span>
                </div>
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <Button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      variant="ghost"
                      className={cn(
                        'flex w-full items-center gap-3 justify-start',
                        isActive
                          ? 'bg-accent text-foreground hover:bg-accent'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <span>{tab.label}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            {/* Content */}
            <div className="min-h-0 w-full max-w-full flex-1 overflow-y-auto">
              {activeTab === 'billing' && (
                <BillingTab returnUrl={returnUrl} isActive={activeTab === 'billing'} />
              )}
              {activeTab === 'transactions' && <TransactionsTab />}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
