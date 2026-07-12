'use client';

/**
 * Thin web wrapper around the SDK's `useRuntimeLocal` (packages/sdk/src/react/
 * use-runtime-local.ts). The pure agent/model/variant selection algorithm —
 * including the `auto`-model resolution (`resolveHiddenAutoModel`, `sendKey`,
 * `onDefault`) and `boundAgentName` handling — lives there now and is shared
 * with any other host. This file only injects the two things that are
 * genuinely web-specific and depend on files outside the SDK's reach:
 *
 * - `freeTier`: derived from apps/web's billing/account-state hook.
 * - `resolveServerDefault` / `model.defaults`: the gateway-backed default-model
 *   preferences API (`useModelDefaults`), which round-trips through
 *   apps/web-only endpoints and isn't (yet) part of the portable SDK surface.
 */

import { useMemo } from 'react';
import { accountStateSelectors, useAccountState, type AccountState } from '@/hooks/billing';
import {
  formatModelString,
  formatPromptModel,
  modelProviderMode,
  parseModelKey,
  resolveCurrentAgentName,
  resolveHiddenAutoModel,
  scopedModelSelectionKey,
  useKortixRouteProjectId,
  useRuntimeLocal as useRuntimeLocalBase,
  type ModelKey,
  type ModelProviderMode,
  type RuntimeLocal as RuntimeLocalBase,
  type UseRuntimeLocalOptions as UseRuntimeLocalOptionsBase,
} from '@kortix/sdk/react';
import { useModelDefaults, type UseModelDefaults } from './use-model-defaults';

export type {
  ModelKey,
  ModelProviderMode,
  RuntimeLocalAgent,
  RuntimeLocalModel,
} from '@kortix/sdk/react';
export {
  formatModelString,
  formatPromptModel,
  modelProviderMode,
  parseModelKey,
  resolveCurrentAgentName,
  resolveHiddenAutoModel,
  scopedModelSelectionKey,
};

export type UseRuntimeLocalOptions = UseRuntimeLocalOptionsBase;

export interface RuntimeLocal extends RuntimeLocalBase {
  model: RuntimeLocalBase['model'] & {
    /** Server-backed account/agent/project default model management (gateway
     * source of truth) — apps/web-only, not part of the portable SDK hook. */
    defaults: UseModelDefaults;
  };
}

/** Pure so it's independently testable without rendering the hook. */
export function computeFreeTier(accountState: AccountState | undefined): boolean {
  const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
  const hasActiveSubscription = !!accountState?.subscription?.subscription_id;
  return (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
}

export function useRuntimeLocal(options: UseRuntimeLocalOptions): RuntimeLocal {
  const projectId = useKortixRouteProjectId();
  const modelDefaults = useModelDefaults(projectId);
  const { data: accountState } = useAccountState();
  const freeTier = useMemo(() => computeFreeTier(accountState), [accountState]);

  const base = useRuntimeLocalBase({
    ...options,
    freeTier,
    resolveServerDefault: modelDefaults.resolveDefaultFor,
  });

  return {
    ...base,
    model: { ...base.model, defaults: modelDefaults },
  };
}
