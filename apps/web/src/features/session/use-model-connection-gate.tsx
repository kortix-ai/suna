'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';

import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getProjectDetail } from '@kortix/sdk/projects-client';

/**
 * Shared "connect a model" routing — where clicking Upgrade / Connect provider
 * should actually take the user, given the current route context (project with
 * the LLM gateway on, project without it, or no project at all). Extracted from
 * `ModelSelector` so any surface (the picker's empty state, the chat input's
 * full-block gate, onboarding) opens the exact same dialogs.
 */
export function useModelConnectionGate() {
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);
  const canWriteProviders =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_WRITE, {
      accountId: projectDetailQuery.data?.project.account_id,
    }).allowed === true;

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] = useState<'connected' | 'catalog' | 'models'>(
    'catalog',
  );

  const openConnectProvider = useCallback(
    (tab: ProviderModalTab = 'providers') => {
      if (projectId) {
        if (llmGatewayEnabled) {
          // Plus → "Add provider" (the core surface); the sliders / manage-models
          // button → "Models". Both land on LLM → Providers, never Files.
          openCustomize('llm-providers', {
            llmProvidersTab: tab === 'models' ? 'models' : 'catalog',
          });
        } else {
          setProjectModalTab(tab === 'providers' ? 'catalog' : tab);
          setProjectModalOpen(true);
        }
        return;
      }
      openProviderModal(tab);
    },
    [projectId, llmGatewayEnabled, openProviderModal, openCustomize],
  );

  const openUpgrade = useCallback(() => {
    openUpgradeDialog({
      reason: 'subscription_required',
      accountId: projectDetailQuery.data?.project.account_id,
    });
  }, [openUpgradeDialog, projectDetailQuery.data?.project.account_id]);

  const modal = projectId ? (
    <ProjectProviderModal
      projectId={projectId}
      open={projectModalOpen}
      onOpenChange={setProjectModalOpen}
      defaultTab={projectModalTab}
      canWrite={canWriteProviders}
    />
  ) : null;

  return { openConnectProvider, openUpgrade, modal };
}
