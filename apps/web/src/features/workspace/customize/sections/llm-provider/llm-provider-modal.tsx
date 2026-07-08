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
import { cn } from '@/lib/utils';
import { Search } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { CatalogTab } from './catalog-tab';
import { ConnectedTab } from './connected-tab';
import { ModelsTab } from './models-tab';
import type { ActiveTab, CatalogSubview, ProjectProviderModalProps } from './types';
import { useConnectedProviders } from './use-connected-providers';
import { pickInitialTab } from './utils';

export type { ProjectProviderModalProps } from './types';

export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  defaultTab,
  initialProviderId,
  asPanel = false,
  allowedTabs,
}: ProjectProviderModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { secretsQuery, connectedProviders, llmGatewayEnabled } = useConnectedProviders(
    projectId,
    open || asPanel,
  );
  const hasConnections = connectedProviders.length > 0;

  const clampTab = useCallback(
    (t: ActiveTab): ActiveTab => (allowedTabs && !allowedTabs.includes(t) ? allowedTabs[0] : t),
    [allowedTabs],
  );

  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    clampTab(pickInitialTab(defaultTab, hasConnections)),
  );
  const [subview, setSubview] = useState<CatalogSubview>({ kind: 'list' });
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      if (initialProviderId) {
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

  const switchTab = useCallback((next: ActiveTab) => {
    setActiveTab(next);
    setSubview({ kind: 'list' });
    setSearch('');
  }, []);

  const inSubflow = activeTab === 'catalog' && subview.kind !== 'list';

  const searchPlaceholder =
    activeTab === 'connected'
      ? 'Search connected providers...'
      : activeTab === 'models'
        ? 'Search models...'
        : 'Search providers...';

  const showTab = (t: ActiveTab) => !allowedTabs || allowedTabs.includes(t);
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
              {showTab('connected') && (
                <TabsTrigger value="connected" className="text-xs">
                  Connected
                </TabsTrigger>
              )}
              {showTab('catalog') && (
                <TabsTrigger value="catalog" className="text-xs">
                  {tHardcodedUi.raw(
                    'componentsProjectsProjectProviderModal.line178JsxTextAddProvider',
                  )}
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
        {secretsQuery.isLoading && (
          <div className="flex min-h-[200px] items-center justify-center">
            <Loading className="text-muted-foreground size-4 shrink-0" />
          </div>
        )}

        {!secretsQuery.isLoading && (
          <>
            <TabsContent value="connected" className="mt-0">
              <ConnectedTab
                projectId={projectId}
                connectedProviders={connectedProviders}
                search={search}
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
              />
            </TabsContent>

            <TabsContent value="models" className="mt-0">
              <ModelsTab
                connectedProviders={connectedProviders}
                search={search}
                llmGatewayEnabled={llmGatewayEnabled}
              />
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
      <ModalContent className="flex h-[min(80vh,680px)] w-[calc(100vw-2rem)] max-w-[600px] flex-col gap-0 overflow-hidden p-0 lg:max-w-[600px]">
        <ModalHeader>
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
