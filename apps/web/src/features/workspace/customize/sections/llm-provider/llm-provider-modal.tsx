'use client';

import { Modal, ModalContent } from '@/components/ui/modal';

import { ModelsView } from './models-view';
import type { ProjectProviderModalProps } from './types';

export type { ProjectProviderModalProps } from './types';

/**
 * Entry point kept for compat with the one remaining non-panel call site
 * (secrets-view.tsx's "Manage providers" fallback when the gateway is off).
 * It used to render a `Connected / Add provider / Models` tabbed modal; it
 * now renders the one-page Models view
 * (docs/specs/2026-07-14-models-page-ui-handoff.md). Panel call sites (the
 * Models Customize section) render `ModelsView` directly instead of going
 * through this wrapper.
 */
export function ProjectProviderModal({
  projectId,
  open,
  onOpenChange,
  asPanel = false,
  canWrite = false,
}: ProjectProviderModalProps) {
  if (asPanel) {
    return <ModelsView projectId={projectId} canWrite={canWrite} />;
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex h-[min(85vh,760px)] w-[calc(100vw-2rem)] max-w-[640px] flex-col gap-0 overflow-hidden p-0 lg:max-w-[640px]">
        <ModelsView projectId={projectId} canWrite={canWrite} />
      </ModalContent>
    </Modal>
  );
}
