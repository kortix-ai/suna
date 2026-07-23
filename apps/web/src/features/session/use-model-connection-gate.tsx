'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { useConnectModal } from '@/features/workspace/customize/sections/llm-provider/connect-modal-host';
import { useLlmProviderCatalogRevision } from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import { useAccountState } from '@/hooks/billing';
import { connectedGatewayProviderIdsFromSecretNames } from '@/hooks/runtime/provider-selection';
import { computeFreeTier } from '@/hooks/runtime/use-runtime-local';
import { hasUsableModel } from '@/hooks/runtime/use-model-store';
import { useProjectLlmGatewayEnabled } from '@/hooks/runtime/use-project-llm-gateway-enabled';
import { isBillingEnabled } from '@/lib/config';
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
  // See use-connected-providers.ts: re-renders when LlmCatalogBootstrap's
  // live-catalog fetch lands, since connectedProviderIds below reads the
  // module-level LLM_PROVIDERS binding.
  const catalogRevision = useLlmProviderCatalogRevision();
  const { open: openConnectModal } = useConnectModal();
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const { llmGatewayEnabled, query: projectDetailQuery } = useProjectLlmGatewayEnabled(projectId);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogRevision drives a re-read of the module-level LLM_PROVIDERS binding, not a value used directly here
  }, [llmGatewayEnabled, secretsQuery.data, catalogRevision]);
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

  // One surface, regardless of route context: the old three-way fork here
  // (Customize-panel deep link when the gateway's on, a locally-hosted modal
  // when it's off, the account-wide provider-modal-store outside a project)
  // is gone — every caller now just opens the root-mounted `ConnectModalHost`
  // (mounted in `app-providers.tsx`) via this store. `tab`/`connectKind` pass
  // straight through to `useConnectModal().open(...)`.
  const openConnectProvider = useCallback(
    (tab?: 'subscriptions' | 'api-keys', opts?: { connectKind?: HarnessAuthKind }) => {
      openConnectModal({ tab, connectKind: opts?.connectKind });
    },
    [openConnectModal],
  );

  const openUpgrade = useCallback(() => {
    openUpgradeDialog({
      reason: 'subscription_required',
      accountId: projectDetailQuery.data?.project.account_id,
    });
  }, [openUpgradeDialog, projectDetailQuery.data?.project.account_id]);

  // Billing off (self-host default): there's no Kortix plan to upgrade to and
  // no <GlobalUpgradeModal/> mounted anywhere to respond to openUpgrade() (see
  // app-providers.tsx's `isBillingEnabled() && <GlobalUpgradeModal />`) — an
  // "Upgrade" button would be a dead click. Callers should hide it and only
  // offer "bring your own key" when this is false.
  const showUpgradeOption = isBillingEnabled();

  return {
    openConnectProvider,
    openUpgrade,
    // Kept for source-compat with call sites still destructuring/rendering it
    // (`model-connection-gate.tsx`, `model-selector.tsx`,
    // `composer-chat-input.tsx`, `project-onboarding-wizard.tsx`) — the
    // connect modal is root-mounted
    // now (`ConnectModalHost`), so there is nothing left for this hook to
    // render locally. Cleaning up those now-dead render sites is left to a
    // follow-up outside this task's file scope.
    modal: null,
    hasSelectableModels,
    entitlementsPending,
    showUpgradeOption,
  };
}
