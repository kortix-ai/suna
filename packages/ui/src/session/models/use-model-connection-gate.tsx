'use client';

import { useQuery } from '@tanstack/react-query';
import { useSessionIds } from '../../providers/session-ids';
import { useUiComponents } from '../../providers/ui-provider';
import { useCallback, useMemo, useState } from 'react';

import { useAccountState } from '../../internal/billing/use-account-state';
import { useOpenedOnce } from '../../internal/hooks/use-opened-once';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectPageCans } from '../../internal/lib/use-project-can';
import type { ProviderModalTab } from '../../internal/stores/provider-modal-store';
import { useUpgradeDialogStore } from '../../internal/stores/upgrade-dialog-store';
import { getProject, platformConfig } from '@kortix/sdk';
import { contract, type FlatModel, type ModelKey, qk } from '@kortix/sdk/react';
import { resolveEntitlementsPending } from '../composer/entitlements-pending';

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
 * provider modal in place. Without a project or the host's
 * `ProjectProviderModal` slot, `canConnectProvider` is false: hide Connect.
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
  // The host's project provider modal (Customize → Models). Without it, or
  // without a project, `canConnectProvider` is false and callers hide Connect.
  const { ProjectProviderModal } = useUiComponents();
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const projectId = resolveGateProjectId(options?.projectId, useSessionIds().projectId);

  // The bare project row (~10 ms), not `/detail`, which reads git and held
  // the picker spinner for up to 2.6 s on prod.
  const projectRowQuery = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => getProject(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
  const caps = useProjectPageCans(projectId ?? undefined);
  // The provider modal's writes are `project.model.write`, the same leaf the
  // model picker gates its "+" and sliders on.
  const canWriteProviders = caps[PROJECT_ACTIONS.PROJECT_MODEL_WRITE]?.allowed === true;

  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalTab, setProjectModalTab] = useState<'providers' | 'models'>('providers');

  const accountStateQuery = useAccountState();
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
  const isModelOffered = useCallback((model: FlatModel) => model.enabled !== false, []);
  const hasSelectableModels = useMemo(
    () => models.some(isModelOffered),
    [models, isModelOffered],
  );
  const modelsByKey = useMemo(
    () =>
      new Map(models.map((model) => [`${model.providerID}:${model.modelID}`, model] as const)),
    [models],
  );
  const isSelectableModel = useCallback(
    (selectedModel: ModelKey) => {
      const model = modelsByKey.get(`${selectedModel.providerID}:${selectedModel.modelID}`);
      if (!model) return false;
      return isModelOffered(model);
    },
    [modelsByKey, isModelOffered],
  );
  // `hasSelectableModels` is only trustworthy once the inputs it reads have
  // loaded. Connected keys are not one of them: `/model-picker` resolves them
  // on the server, so the gate never waits on `/secrets` (it held the picker
  // for 1.8 s on dev, inside the ~45 requests a project page fires at load).
  //
  // Each query is passed WHOLE. This used to restate every query's `enabled`
  // inline, because a disabled react-query reports `isPending` forever; one
  // such restatement went stale (`secretsQuery` gained `&& canReadSecrets`,
  // this expression did not) and every project member got a model picker that
  // spun over a catalog already sitting in the browser. `fetchStatus` answers
  // the question without a copy to keep in sync — see `entitlements-pending`.
  const entitlementsPending = resolveEntitlementsPending([
    projectRowQuery,
    accountStateQuery,
  ]);

  const canConnectProvider = !!(projectId && ProjectProviderModal);
  const openConnectProvider = useCallback(
    (tab: ProviderModalTab = 'providers') => {
      if (!canConnectProvider) return;
      setProjectModalTab(projectProviderModalTab(tab));
      setProjectModalOpen(true);
    },
    [canConnectProvider],
  );

  const openUpgrade = useCallback(() => {
    openUpgradeDialog({
      reason: 'subscription_required',
      accountId: projectRowQuery.data?.account_id,
    });
  }, [openUpgradeDialog, projectRowQuery.data?.account_id]);

  const providerModalOpened = useOpenedOnce(projectModalOpen);
  const modal =
    projectId && providerModalOpened && ProjectProviderModal ? (
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
  // exactly why `/new` had to mount its own. It is the SDK's flag
  // (`configureKortix({ billingEnabled })`), the one every billing gate reads.
  const showUpgradeOption = !!platformConfig().billingEnabled;

  return {
    canConnectProvider,
    openConnectProvider,
    openUpgrade,
    modal,
    hasSelectableModels,
    isSelectableModel,
    entitlementsPending,
    showUpgradeOption,
  };
}
