'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk';
import { contract, type ModelKey, qk } from '@kortix/sdk/react';
import type { FlatModel } from './session-chat-input';

export function projectProviderModalTab(tab: ProviderModalTab): 'connected' | 'catalog' | 'models' {
  return tab === 'providers' ? 'catalog' : tab;
}

/**
 * Shared "connect a model" routing. Project actions open the project-scoped
 * provider modal in place. Non-project actions use the global provider modal.
 * Extracted from `ModelSelector` so the picker, chat gate, and onboarding use
 * the same surface.
 *
 * Also computes `hasSelectableModels` — pass the caller's flattened model list
 * (default `[]` for callers that only need the routing actions). This is
 * deliberately NOT `models.length > 0`: the raw provider catalog can carry
 * models the project does not offer. See `isModelOffered` for the check.
 */
export function useModelConnectionGate(models: FlatModel[] = []) {
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
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

  const baseModels = useMemo(
    () => (llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix')),
    [models, llmGatewayEnabled],
  );
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId ?? ''),
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && llmGatewayEnabled,
    ...contract('config'),
  });
  const { isPending: accountStatePending } = useAccountState();
  // Availability is SERVER-resolved, never re-derived here. `/model-picker`
  // already applies plan entitlement (`freeManagedOnly`) and connected-BYOK
  // filtering, then stamps `enabled` on every model it serves. This gate must
  // read that flag.
  //
  // *** BUG THIS FIXES (clicking a model in the picker did nothing) ***
  // This hook used to recompute entitlement with `hasUsableModel(models, {
  // connectedProviderIds, freeTier })`, where `freeTier` came from the BILLING
  // account state (`tier_key` free/none and no `subscription_id`). The server
  // computes it as `KORTIX_BILLING_INTERNAL_ENABLED ? accountIsFreeTier(...) :
  // false`, so with billing off the two disagree: `/model-defaults` answers
  // `freeTier: false` and `/model-picker` serves `enabled: true`, while this
  // gate answered "free tier" and reported EVERY managed model unselectable.
  // `resolveAvailableSelectedModel` then nulled the pick, so the trigger stayed
  // on `unsetLabel`, no check mark rendered, and each click looked like a no-op
  // even though `onSelect` fired and the model store was written.
  //
  // Native (non-gateway) catalogs carry no `enabled` — opencode only lists
  // models of CONNECTED providers, so presence there already means usable.
  const isModelOffered = useCallback((model: FlatModel) => model.enabled !== false, []);
  const hasSelectableModels = useMemo(
    () => baseModels.some(isModelOffered),
    [baseModels, isModelOffered],
  );
  const modelsByKey = useMemo(
    () =>
      new Map(
        baseModels.map((model) => [`${model.providerID}:${model.modelID}`, model] as const),
      ),
    [baseModels],
  );
  const isSelectableModel = useCallback(
    (selectedModel: ModelKey) => {
      const model = modelsByKey.get(`${selectedModel.providerID}:${selectedModel.modelID}`);
      if (!model) return false;
      return isModelOffered(model);
    },
    [modelsByKey, isModelOffered],
  );
  // `hasSelectableModels` is only trustworthy once every input the served
  // catalog depends on has loaded — a secret write invalidates `/model-picker`,
  // so a gate keyed on a half-loaded answer flashes, then vanishes. Disabled
  // queries stay `isPending` forever, so each is guarded by its `enabled`
  // condition.
  const entitlementsPending =
    (!!projectId && projectDetailQuery.isPending) ||
    (!!projectId && llmGatewayEnabled && secretsQuery.isPending) ||
    accountStatePending;

  const openConnectProvider = useCallback(
    (tab: ProviderModalTab = 'providers') => {
      if (projectId) {
        setProjectModalTab(projectProviderModalTab(tab));
        setProjectModalOpen(true);
        return;
      }
      openProviderModal(tab);
    },
    [projectId, openProviderModal],
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

  // Billing off (self-host default): there's no Kortix plan to upgrade to and
  // no <GlobalUpgradeModal/> mounted anywhere to respond to openUpgrade() (see
  // app-providers.tsx's `isBillingEnabled() && <GlobalUpgradeModal />`) — an
  // "Upgrade" button would be a dead click. Callers should hide it and only
  // offer "bring your own key" when this is false.
  const showUpgradeOption = isBillingEnabled();

  return {
    openConnectProvider,
    openUpgrade,
    modal,
    hasSelectableModels,
    isSelectableModel,
    entitlementsPending,
    showUpgradeOption,
  };
}
