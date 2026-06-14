'use client';

import { InstanceMembersPanel } from '@/components/instances/instance-members-panel';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { Icon } from '@/features/icon/icon';
import { getCurrentInstanceIdFromPathname } from '@/lib/instance-routes';
import {
  getInstanceTabs,
  getPreferenceTabs,
  type SettingsTab,
  type SettingsTabId,
} from '@/lib/menu-registry';
import { listSandboxes, type SandboxInfo } from '@/lib/platform-client';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { AppearanceTab } from './appearance-tab';
import { CliTokensTab } from './cli-tokens-tab';
import { GeneralTab } from './general-tab';
import { KeyboardShortcutsTab } from './keyboard-shortcuts-tab';
import { NotificationsTab } from './notifications-tab';
import { SoundsTab } from './sounds-tab';

type TabId = SettingsTabId;

interface Tab extends SettingsTab {
  description?: string;
  disabled?: boolean;
}

const TAB_DESCRIPTIONS: Partial<Record<TabId, string>> = {
  sounds: 'Choose sound packs and preview notification sounds.',
  notifications: 'Control browser notifications and delivery preferences.',
  shortcuts: 'View keyboard shortcuts available across the app.',
  tokens: 'Create and manage CLI tokens for the Kortix command line.',
  'instance-members': 'Manage who has access to this instance.',
};

interface SidePanelUserSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: TabId;
}

function SidePanelUserSettings({
  open,
  onOpenChange,
  defaultTab = 'general',
}: SidePanelUserSettingsProps) {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const pathname = usePathname();

  const currentInstanceId = getCurrentInstanceIdFromPathname(pathname);
  const instanceSandboxQuery = useQuery({
    queryKey: ['platform', 'sandbox-by-id', currentInstanceId],
    queryFn: async (): Promise<SandboxInfo | null> => {
      if (!currentInstanceId) return null;
      const all = await listSandboxes(currentInstanceId);
      return all.find((s) => s.sandbox_id === currentInstanceId) ?? null;
    },
    enabled: open && !!currentInstanceId,
    staleTime: 30_000,
  });
  const instanceSandbox = instanceSandboxQuery.data ?? null;
  const hasInstance = !!instanceSandbox;

  const withDescription = (tabs: SettingsTab[]): Tab[] =>
    tabs.map((tab) => ({
      ...tab,
      description: TAB_DESCRIPTIONS[tab.id],
    }));

  const preferenceTabs: Tab[] = React.useMemo(() => withDescription(getPreferenceTabs()), []);
  const instanceTabs: Tab[] = React.useMemo(
    () => (hasInstance ? withDescription(getInstanceTabs()) : []),
    [hasInstance],
  );
  const accountTabs: Tab[] = React.useMemo(
    () => withDescription([{ id: 'tokens', label: 'CLI tokens', icon: KeyRound }]),
    [],
  );

  const instanceLoading =
    open && !!currentInstanceId && !hasInstance && instanceSandboxQuery.isLoading;

  type TabGroup = { label: string; tabs: Tab[]; skeleton?: boolean };
  const tabGroups: TabGroup[] = [
    { label: 'Preferences', tabs: preferenceTabs },
    { label: 'Account', tabs: accountTabs },
    ...(instanceTabs.length > 0
      ? [{ label: instanceSandbox?.name || 'Instance', tabs: instanceTabs }]
      : instanceLoading
        ? [{ label: '', tabs: [], skeleton: true }]
        : []),
  ];

  const allTabs = React.useMemo(
    () => [...preferenceTabs, ...accountTabs, ...instanceTabs],
    [preferenceTabs, accountTabs, instanceTabs],
  );
  const activeContentTab: TabId = allTabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : 'general';

  useEffect(() => {
    if (open && defaultTab) {
      setActiveTab(defaultTab);
    }
  }, [open, defaultTab]);

  useEffect(() => {
    if (!allTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab('general');
    }
  }, [activeTab, allTabs]);

  const activeTabMeta = allTabs.find((tab) => tab.id === activeContentTab);

  const renderSettingsTabButton = (tab: Tab, className?: string) => {
    const TabIcon = tab.icon;
    const isActive = activeContentTab === tab.id;

    return (
      <Button
        key={tab.id}
        variant={isActive ? 'secondary' : 'ghost'}
        size="sm"
        disabled={tab.disabled}
        className={cn(
          'justify-between px-2 has-[>svg]:px-2',
          isActive ? 'border-primary/10 border' : 'border border-transparent',
          className,
        )}
        onClick={() => setActiveTab(tab.id)}
      >
        <div className="flex items-center gap-2">
          <TabIcon className="size-4" />
          {tab.label}
        </div>
      </Button>
    );
  };

  const renderActiveTabContent = () => (
    <>
      {activeContentTab === 'general' && <GeneralTab onClose={() => onOpenChange(false)} />}
      {activeContentTab === 'appearance' && <AppearanceTab />}
      {activeContentTab === 'sounds' && <SoundsTab />}
      {activeContentTab === 'notifications' && <NotificationsTab />}
      {activeContentTab === 'shortcuts' && <KeyboardShortcutsTab />}
      {activeContentTab === 'tokens' && <CliTokensTab />}
      {activeContentTab === 'instance-members' && instanceSandbox && (
        <InstanceMembersPanel sandboxId={instanceSandbox.sandbox_id} />
      )}
    </>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        showCloseButton={false}
        className="min-h-[90%] w-full border-none space-y-0 md:min-h-fit lg:max-w-4xl"
      >
        <div className="grid h-[650px] grid-cols-12">
          <div className="border-ring/10 bg-background dark:bg-sidebar-border/5 col-span-12 hidden flex-col border-r p-2 lg:col-span-3 lg:flex">
            <div className="flex-grow">
              <div className="space-y-2">
                <ModalClose className="ring-0 focus:ring-0">
                  <Hint label="Close" className="z-[9999]" side="right">
                    <Button
                      variant="ghost"
                      className="text-primary hover:text-primary size-8 rounded-md p-0 text-xs font-semibold transition-colors focus:outline-none"
                    >
                      <Icon.Close className="size-4 stroke-1" />
                      <span className="sr-only">Close</span>
                    </Button>
                  </Hint>
                </ModalClose>
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex flex-col gap-4">
                    {tabGroups.map((group, groupIdx) => (
                      <div key={group.skeleton ? `skeleton-${groupIdx}` : group.label}>
                        {group.label ? (
                          <div className="px-2 pb-1.5">
                            {group.skeleton ? (
                              <Skeleton className="h-3 w-20 rounded" />
                            ) : (
                              <span className="text-muted-foreground  font-medium tracking-wider text-xs">
                                {group.label}
                              </span>
                            )}
                          </div>
                        ) : group.skeleton ? (
                          <div className="px-2 pb-1.5">
                            <Skeleton className="h-3 w-20 rounded" />
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-1">
                          {group.skeleton ? (
                            <>
                              <Skeleton className="h-9 w-full rounded-md" />
                              <Skeleton className="h-9 w-full rounded-md" />
                            </>
                          ) : (
                            group.tabs.map((tab) => (
                              <div className="relative" key={`${tab.id}-settings-tab`}>
                                {renderSettingsTabButton(tab, 'w-full')}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="col-span-0 hidden min-h-0 flex-col lg:col-span-9 lg:flex">
            <ModalHeader>
              <ModalTitle>{activeTabMeta?.label ?? 'Settings'}</ModalTitle>
              <ModalDescription>{activeTabMeta?.description ?? ''}</ModalDescription>
            </ModalHeader>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {renderActiveTabContent()}
            </div>
          </div>

          <div className="col-span-12 w-full lg:hidden">
            <ModalHeader>
              <ModalTitle>{activeTabMeta?.label ?? 'Settings'}</ModalTitle>
              <ModalDescription>{activeTabMeta?.description ?? ''}</ModalDescription>
            </ModalHeader>

            <div className="flex grow flex-row flex-wrap gap-2 p-4 md:p-2">
              {instanceLoading ? (
                <>
                  <Skeleton className="h-9 w-24 rounded-md" />
                  <Skeleton className="h-9 w-24 rounded-md" />
                </>
              ) : null}
              {allTabs.map((tab) => renderSettingsTabButton(tab, 'w-fit'))}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {renderActiveTabContent()}
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}

export { SidePanelUserSettings };
