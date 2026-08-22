'use client';

/**
 * `ProjectProviderModal` — the `Modal` SHELL around `provider-connect.tsx`.
 * It owns no connect UI of its own any more: JAY-510 collapsed the old
 * "Add provider" and "Connected" tabs into `ProviderConnect`'s sections
 * (Connected / Add a provider / More providers), and deleted the always-on
 * search bar that used to sit above the tab row — the search now lives inside
 * the More-providers disclosure where it belongs.
 *
 * Two tabs, because they are two different questions:
 *   - **Providers** — `ProviderConnect`: which provider keys the Kortix
 *                     gateway holds for this project (BYOK).
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

import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProviderConnect } from '@/features/providers/provider-connect';
import { useState } from 'react';
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
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* ONE height, declared once as a var and pinned from both sides.
          `h-` alone is not enough on desktop: ModalVariants' bottom side
          carries `lg:h-auto` (modal.tsx), which twMerge does NOT collapse
          into the unprefixed `h-[…]` (different modifier group) — so the
          modal silently became content-sized at `lg:` and its height jumped
          with every tab switch (3 key rows vs 34 model rows). `lg:min-h` +
          `lg:max-h` clamp that `h-auto` to a constant.
          The unprefixed mobile sheet keeps its own `max-h-[90%]` cap. */}
      <ModalContent className="flex h-(--provider-modal-h) w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 [--provider-modal-h:min(680px,calc(100dvh-2rem))] lg:max-h-(--provider-modal-h) lg:min-h-(--provider-modal-h) lg:max-w-4xl">
        <ModalHeader className="shrink-0">
          <ModalTitle>AI models</ModalTitle>
          {/* One line. Each tab states its own rule beside its own controls,
              so repeating "everyone on this project can use it" up here only
              makes the reader read it twice on the way to the same field. */}
          <ModalDescription>
            Connect your own AI accounts, and choose which models this project can use.
          </ModalDescription>
        </ModalHeader>

        <ProviderModalTabs
          key={`${open}-${defaultTab ?? ''}`}
          projectId={projectId}
          open={open}
          canWrite={canWrite}
          defaultTab={defaultTab}
        />
      </ModalContent>
    </Modal>
  );
}

/**
 * The tab strip, below the `key` boundary the shell owns.
 *
 * CONTROLLED, but with no effect and no re-seeding: `useState`'s initializer
 * runs once per mount, and the parent's `key={`${open}-${defaultTab}`}`
 * remounts this on every open — so reopening still lands on the requested tab,
 * exactly as the uncontrolled version did, with no `setState` in an effect
 * body (`react-hooks/set-state-in-effect`).
 *
 * Controlled so a later caller can move the reader between the two tabs
 * without remounting the shell.
 */
function ProviderModalTabs({
  projectId,
  open,
  canWrite,
  defaultTab,
}: {
  projectId: string;
  open: boolean;
  canWrite: boolean;
  defaultTab?: ActiveTab;
}) {
  const [tab, setTab] = useState<ActiveTab>(() => pickInitialTab(defaultTab));

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as ActiveTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="flex items-center gap-3 px-5 pb-3">
        <TabsList className="flex w-full shrink-0 items-center justify-start" type="underline">
          {/* "API keys", not "Providers" — the tab is named after what you do
              on it. Everything on that tab is a field you paste a key into,
              and "API key" is the phrase every provider's own site uses on the
              page you copy it from. */}
          <TabsTrigger value="providers" className="w-auto flex-none text-xs" size="sm">
            API keys
          </TabsTrigger>
          <TabsTrigger value="models" className="w-auto flex-none text-xs" size="sm">
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
  );
}
