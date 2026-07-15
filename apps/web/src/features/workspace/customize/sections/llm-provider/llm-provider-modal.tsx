'use client';

import { Modal, ModalContent } from '@/components/ui/modal';

import { ModelsView } from './models-view';
import type { ProjectProviderModalProps } from './types';

export type { ProjectProviderModalProps } from './types';

/**
 * Entry point kept for compat with existing call sites (gateway-view.tsx,
 * secrets-view.tsx, use-model-connection-gate.tsx). It used to render a
 * `Connected / Add provider / Models` tabbed modal; it now renders the
 * one-page Models view (docs/specs/2026-07-14-models-page-ui-handoff.md).
 * `defaultTab`, `allowedTabs`, and `initialProviderId` no longer apply to a
 * tab-less page — they're accepted and ignored so call sites keep compiling
 * unchanged.
 */
export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  asPanel = false,
  canWrite = false,
  connectRequest = null,
}: ProjectProviderModalProps) {
  if (asPanel) {
    return <ModelsView projectId={projectId} canWrite={canWrite} connectRequest={connectRequest} />;
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex h-[min(85vh,760px)] w-[calc(100vw-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden p-0 lg:max-w-[640px]">
        <ModelsView projectId={projectId} canWrite={canWrite} connectRequest={connectRequest} />
      </ModalContent>
    </Modal>
  );
}
