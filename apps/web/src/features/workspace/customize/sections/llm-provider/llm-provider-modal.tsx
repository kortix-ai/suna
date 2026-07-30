'use client';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { warningToast } from '@/components/ui/toast';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { CatalogTab } from './catalog-tab';
import { ConnectedTab } from './connected-tab';
import { ModelsTab } from './models-tab';
import type { ActiveTab, CatalogSubview, ProjectProviderModalProps } from './types';
import { useConnectedProviders } from './use-connected-providers';
import { pickInitialTab } from './utils';

export type { ProjectProviderModalProps } from './types';

const CONNECTION_REFRESH_TIMEOUT_MS = 45_000;

export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  defaultTab,
  initialProviderId,
  asPanel = false,
  allowedTabs,
  canWrite = false,
}: ProjectProviderModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { connectedProviders, llmGatewayEnabled, providerStateLoading } = useConnectedProviders(
    projectId,
    open || asPanel,
  );
  const hasConnections = connectedProviders.length > 0;

  // Read-only members never reach the catalog (its detail → connect forms POST
  // secrets and would 403); fold any attempt to land there back to Connected.
  const clampTab = useCallback(
    (t: ActiveTab): ActiveTab => {
      const resolved = allowedTabs && !allowedTabs.includes(t) ? allowedTabs[0] : t;
      return !canWrite && resolved === 'catalog' ? 'connected' : resolved;
    },
    [allowedTabs, canWrite],
  );

  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    clampTab(pickInitialTab(defaultTab, hasConnections)),
  );
  const [subview, setSubview] = useState<CatalogSubview>({ kind: 'list' });
  const [search, setSearch] = useState('');
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const switchTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    setSubview({ kind: 'list' });
    setSearch('');
  }, []);

  useEffect(() => {
    if (open) {
      setPendingProviderId(null);
      if (initialProviderId && canWrite) {
        setActiveTab(clampTab('catalog'));
        setSubview({ kind: 'connect', providerId: initialProviderId });
      } else {
        setActiveTab(clampTab(pickInitialTab(defaultTab, hasConnections)));
        setSubview({ kind: 'list' });
      }
      setSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultTab]);

  useEffect(() => {
    if (!pendingProviderId) return;

    if (connectedProviders.some((provider) => provider.id === pendingProviderId)) {
      setPendingProviderId(null);
      switchTab('connected');
      return;
    }

    const timeout = window.setTimeout(() => {
      setPendingProviderId(null);
      warningToast('The key was saved, but the connected provider list did not refresh.');
    }, CONNECTION_REFRESH_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [connectedProviders, pendingProviderId, switchTab]);

  const inSubflow =
    activeTab === 'catalog' && (subview.kind !== 'list' || pendingProviderId !== null);
  const pendingProviderLabel =
    pendingProviderId === 'codex'
      ? 'ChatGPT'
      : pendingProviderId === 'claude'
        ? 'Claude Code'
        : pendingProviderId
          ? (LLM_PROVIDER_BY_ID.get(pendingProviderId)?.label ?? pendingProviderId)
          : null;

  const searchPlaceholder =
    activeTab === 'connected'
      ? 'Search connected providers...'
      : activeTab === 'models'
        ? 'Search models...'
        : 'Search providers...';

  const showTab = (t: ActiveTab) =>
    (!allowedTabs || allowedTabs.includes(t)) && (canWrite || t !== 'catalog');
  const showTabBar = !allowedTabs || allowedTabs.length > 1;

  const body = (
    <Tabs
      value={activeTab}
      onValueChange={(value) => switchTab(value as ActiveTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      {!inSubflow && (
        <div
          className={cn(
            'flex items-center gap-3 px-5',
            asPanel ? 'border-border/50 border-b py-3' : 'pb-3',
          )}
        >
          {showTabBar && (
            <TabsList className="shrink-0">
              {showTab('catalog') && (
                <TabsTrigger value="catalog" className="text-xs">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line178JsxTextAddProvider',
                  )}
                </TabsTrigger>
              )}
              {showTab('connected') && (
                <TabsTrigger value="connected" className="text-xs">
                  Connected
                </TabsTrigger>
              )}
              {showTab('models') && (
                <TabsTrigger value="models" className="text-xs">
                  Models
                </TabsTrigger>
              )}
            </TabsList>
          )}

          <InputGroupSearch className={showTabBar ? 'ml-auto max-w-[260px] flex-1' : 'w-full'}>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              type="text"
              placeholder={searchPlaceholder}
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <InputGroupSearchClear onClick={() => setSearch('')} />
          </InputGroupSearch>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pendingProviderId && (
          <div
            className="flex min-h-[240px] flex-col items-center justify-center gap-2 px-5 text-center"
            role="status"
            aria-live="polite"
          >
            <Loading className="text-muted-foreground size-5 shrink-0" />
            <p className="text-foreground text-sm font-medium">
              Connecting {pendingProviderLabel}…
            </p>
            <p className="text-muted-foreground max-w-xs text-xs text-pretty">
              Refreshing the provider and model list. This can take a few seconds.
            </p>
          </div>
        )}

        {!pendingProviderId && providerStateLoading && (
          <div
            className="flex min-h-[200px] items-center justify-center"
            role="status"
            aria-label="Loading providers"
          >
            <Loading className="text-muted-foreground size-4 shrink-0" />
          </div>
        )}

        {!pendingProviderId && !providerStateLoading && (
          <>
            <TabsContent value="connected" className="mt-0">
              <ConnectedTab
                projectId={projectId}
                connectedProviders={connectedProviders}
                search={search}
                canWrite={canWrite}
                onAddProvider={() => switchTab('catalog')}
              />
            </TabsContent>

            <TabsContent value="catalog" className="mt-0">
              <CatalogTab
                projectId={projectId}
                connectedIds={new Set(connectedProviders.map((p) => p.id))}
                search={search}
                subview={subview}
                setSubview={setSubview}
                onProviderConnected={setPendingProviderId}
                canWrite={canWrite}
              />
            </TabsContent>

            <TabsContent value="models" className="mt-0">
              <ModelsTab projectId={projectId} search={search} />
            </TabsContent>
          </>
        )}
      </div>
    </Tabs>
  );

  if (asPanel) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex h-[min(680px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[600px] flex-col gap-0 overflow-hidden p-0 lg:max-w-[600px]">
        <ModalHeader className="shrink-0 pb-3">
          <ModalTitle>
            {tHardcodedUi.raw('componentsProjectsProjectProviderModal.line151JsxTextLlmProviders')}
          </ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsProjectsProjectProviderModal.line153JsxTextConnectProvidersKeysAreStoredPerProjectAnd',
            )}
          </ModalDescription>
        </ModalHeader>
        {body}
      </ModalContent>
    </Modal>
  );
}
