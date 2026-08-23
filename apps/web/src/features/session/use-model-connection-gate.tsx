'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import type { ProviderModalTab } from '@/stores/provider-modal-store';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk';
import { contract, type ModelKey, qk } from '@kortix/sdk/react';
import type { FlatModel } from './session-chat-input';

/**
 * `ProviderModalTab` is the caller-facing vocabulary ('providers' | 'connected'
 * | 'models'). JAY-510 merged the modal's 'catalog' and 'connected' tabs into
 * one `providers` surface, so both of those now resolve to it; only 'models'
 * still names a distinct tab.
 */
export function projectProviderModalTab(tab: ProviderModalTab): 'providers' | 'models' {
  return tab === 'models' ? 'models' : 'providers';
}

/**
 * Which project this gate acts on. An explicitly passed id wins; the `[id]`
 * route segment is the fallback.
 *
 * The fallback is what every original caller relies on — they all render under
 * `/projects/[id]`. The explicit id exists because the onboarding wizard's plan
 * step now also runs on `/new` (`app/(app)/new`), which has NO `[id]` segment:
 * there the route yields `null`, `modal` is therefore `null`, and
 * `openConnectProvider` renders nothing while the step's only control never
 * advances the wizard.
 *
 * `!== undefined`, never `??`: a caller that deliberately passes `null` means
 * "act on no project", and must not silently inherit whatever route it happens
 * to be rendered under.
 *
 * Exported so this rule is provable — the hook itself cannot be rendered in
 * `apps/web`'s test harness (no jsdom, and `mock.module` is process-wide across
 * a non---isolate `bun test` run).
 */
export function resolveGateProjectId(
  explicitId: string | null | undefined,
  routeId: unknown,
): string | null {
  if (explicitId !== undefined) return explicitId;
  return typeof routeId === 'string' ? routeId : null;
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
 *
 * `options.projectId` names the project explicitly, for callers that render
 * outside `/projects/[id]`. Omitting it keeps the original route-inferred
 * behaviour verbatim — see `resolveGateProjectId`.
 */
export function useModelConnectionGate(
  models: FlatModel[] = [],
  options?: { projectId?: string | null },
) {
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const params = useParams<{ id?: string }>();
  const projectId = resolveGateProjectId(options?.projectId, params?.id);

  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  // The detail read serves `account_id` only (permission probes + the upgrade
  // dialog). Gateway mode is the only mode, so no flag is read off it.
  const canWriteProviders =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_WRITE, {
      accountId: projectDetailQuery.data?.project.account_id,
    }).allowed === true;

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] = useState<'providers' | 'models'>('providers');

  // Gateway mode is the only mode: every served model is a `kortix` model.
  const baseModels = models;
  // `project.secret.read` is manager-tier, so for a project `member` this query
  // was a guaranteed 403 on every project-home render — a permission check
  // performed by asking the server to refuse. Gate it on the leaf instead.
  // `allowed === true` also holds the query while the probe is still loading,
  // so it fires once, when the answer is known, or not at all.
  const canReadSecrets =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_SECRET_READ, {
      accountId: projectDetailQuery.data?.project.account_id,
    }).allowed === true;
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId ?? ''),
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && canReadSecrets,
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
  // Every catalog entry carries `enabled`: the picker is always the gateway's
  // `/model-picker` answer; there is no second (native) catalog shape.
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
    (!!projectId && canReadSecrets && secretsQuery.isPending) || accountStatePending;

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
  // no <GlobalUpgradeModal/> mounted anywhere to respond to openUpgrade()
  // (every host mounts it behind the same flag — `app-providers.tsx`'s
  // `isBillingEnabled() && <GlobalUpgradeModal />`, and the same line on
  // `/new`) — an "Upgrade" button would be a dead click. Callers should hide it
  // and only offer "bring your own key" when this is false.
  //
  // This flag answers "is billing ON", NOT "is a host MOUNTED". A route that
  // enables billing without mounting one still yields a dead click — which is
  // exactly why `/new` had to mount its own.
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
