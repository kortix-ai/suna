'use client';

/**
 * `ProjectProviderModal` — the `Modal` SHELL around `provider-connect.tsx`.
 * It owns no connect UI of its own any more: JAY-510 collapsed the old
 * "Add provider" and "Connected" tabs into `ProviderConnect`'s four sections
 * (Connected / Add a provider / More providers / Custom provider), and deleted
 * the always-on search bar that used to sit above the tab row — the search now
 * lives inside the More-providers disclosure where it belongs.
 *
 * Two tabs remain, because they are two different questions:
 *   - **Providers** — `ProviderConnect`: which providers this project can call.
 *   - **Models**    — `ModelsTab`: which of the connected providers' models the
 *                     picker offers. Kept as its own tab rather than nested one
 *                     level deeper, which is where it used to live.
 *
 * Two live mounts, both dialogs: the model selector's connect dialog
 * (`use-model-connection-gate.tsx:138`) and the Secrets tab's "Manage
 * providers" button (`secrets-view.tsx:353`). The Models settings tab mounts
 * `ProviderConnect` DIRECTLY (`gateway-view.tsx`) — connecting a provider there
 * opens no dialog at all, which is JAY-510's first acceptance criterion.
 */

import { Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProviderConnect } from '@/features/providers/provider-connect';
import { useEffect, useState } from 'react';
import { ModelsTab } from './models-tab';
import type { ActiveTab, ProjectProviderModalProps } from './types';
import { pickInitialTab } from './utils';

export type { ProjectProviderModalProps } from './types';

export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  defaultTab,
  canWrite = false,
}: ProjectProviderModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => pickInitialTab(defaultTab));

  useEffect(() => {
    if (open) setActiveTab(pickInitialTab(defaultTab));
  }, [open, defaultTab]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex h-[min(680px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[600px] flex-col gap-0 overflow-hidden p-0 lg:max-w-[600px]">
        <ModalHeader className="shrink-0 pb-3">
          <ModalTitle>Models</ModalTitle>
          <ModalDescription>
            Connect providers. Keys are stored per project and shared with everyone on it.
          </ModalDescription>
        </ModalHeader>
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ActiveTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="flex items-center gap-3 px-5 pb-3">
            <TabsList className="shrink-0">
              <TabsTrigger value="providers" className="text-xs">
                Providers
              </TabsTrigger>
              <TabsTrigger value="models" className="text-xs">
                Models
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="providers" className="mt-0">
              <ProviderConnect projectId={projectId} canWrite={canWrite} enabled={open} />
            </TabsContent>
            <TabsContent value="models" className="mt-0">
              <ModelsTab projectId={projectId} />
            </TabsContent>
          </div>
        </Tabs>
      </ModalContent>
    </Modal>
  );
}
