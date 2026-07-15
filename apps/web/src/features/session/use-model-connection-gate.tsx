'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useAccountState } from '@/hooks/billing';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/runtime/provider-selection';
import { computeFreeTier } from '@/hooks/runtime/use-runtime-local';
import { hasUsableModel } from '@/hooks/runtime/use-model-store';
import { useProjectLlmGatewayEnabled } from '@/hooks/runtime/use-project-llm-gateway-enabled';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { listProjectSecrets, type HarnessAuthKind } from '@kortix/sdk/projects-client';
import type { FlatModel } from './session-chat-input';

/**
 * Shared "connect a model" routing — where clicking Upgrade / Connect provider
 * should actually take the user, given the current route context (project with
 * the LLM gateway on, project without it, or no project at all). Extracted from
 * `ModelSelector` so any surface (the picker's empty state, the chat input's
 * full-block gate, onboarding) opens the exact same dialogs.
 *
 * Also computes `hasSelectableModels` — pass the caller's flattened model list
 * (default `[]` for callers that only need the routing actions). This is
 * deliberately NOT `models.length > 0` or a raw provider-connected check: the
 * gateway bakes its whole catalog into every project regardless of plan or
 * connected keys, so the raw list is basically never empty. See
 * `hasUsableModel` for the actual entitlement check.
 */
export function useModelConnectionGate(models: FlatModel[] = []) {
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const { llmGatewayEnabled, query: projectDetailQuery } = useProjectLlmGatewayEnabled(projectId);
  const canWriteProviders =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_WRITE, {
      accountId: projectDetailQuery.data?.project.account_id,
    }).allowed === true;

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] = useState<'connected' | 'catalog' | 'models'>(
    'catalog',
  );
  const [connectRequest, setConnectRequest] = useState<{ kind: HarnessAuthKind; nonce: number } | null>(
    null,
  );

  // Same entitlement inputs ModelSelector uses: which BYOK providers are
  // connected (from project secrets), and whether the account is on free
  // tier (hides Kortix-managed models — they paywall server-side otherwise).
  const baseModels = useMemo(
    () => (llmGatewayEnabled ? models : models.filter((m) => m.providerID !== 'kortix')),
    [models, llmGatewayEnabled],
  );
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && llmGatewayEnabled,
    staleTime: 10_000,
  });
  const connectedProviderIds = useMemo(() => {
    if (!llmGatewayEnabled) return new Set<string>();
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    const secretNames = new Set(items.map((secret: { name: string }) => secret.name));
    return connectedGatewayProviderIdsFromSecretNames(secretNames);
  }, [llmGatewayEnabled, secretsQuery.data]);
  const { data: accountState, isPending: accountStatePending } = useAccountState();
  const freeTier = useMemo(() => computeFreeTier(accountState), [accountState]);
  const hasSelectableModels = useMemo(
    () =>
      hasUsableModel(baseModels, { connectedProviderIds, freeTier: llmGatewayEnabled && freeTier }),
    [baseModels, connectedProviderIds, llmGatewayEnabled, freeTier],
  );
  // `hasSelectableModels` is only trustworthy once every entitlement input has
  // loaded — before that, a subscribed account with zero BYOK keys computes as
  // "nothing usable" (accountState undefined → freeTier, secrets undefined →
  // no connected providers) and any gate keyed on it flashes, then vanishes.
  // Disabled queries stay `isPending` forever, so each is guarded by its
  // `enabled` condition.
  const entitlementsPending =
    (!!projectId && projectDetailQuery.isPending) ||
    (!!projectId && llmGatewayEnabled && secretsQuery.isPending) ||
    accountStatePending;

  const openConnectProvider = useCallback(
    (tab: ProviderModalTab = 'providers', opts?: { connectKind?: HarnessAuthKind }) => {
      if (projectId) {
        if (llmGatewayEnabled) {
          // Plus → "Add provider" (the core surface); the sliders / manage-models
          // button → "Models". Both land on LLM → Providers, never Files.
          openCustomize('llm-providers', {
            llmProvidersTab: tab === 'models' ? 'models' : 'catalog',
            llmProvidersConnectKind: opts?.connectKind,
          });
        } else {
          setConnectRequest(opts?.connectKind ? { kind: opts.connectKind, nonce: Date.now() } : null);
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
      connectRequest={connectRequest}
    />
  ) : null;

  return { openConnectProvider, openUpgrade, modal, hasSelectableModels, entitlementsPending };
}
