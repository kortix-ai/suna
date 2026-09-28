/**
 * What the models step's primary button does. The label names the action, so
 * it must follow what is connected, not only which row is picked.
 */

export type PlanChoice = 'kortix' | 'byok';
export type PlanAction = 'open' | 'addKey' | 'seePlans';

export interface ModelAccess {
  /** A model from a provider key the project added is offered. */
  hasOwnKey: boolean;
  /** A Kortix-managed model is offered. */
  hasKortixModels: boolean;
  /**
   * The account may run Kortix models now, from the billing state machine
   * (`billing-gate-state.ts`). `false` for a plan with an empty wallet, which
   * still lists the models. Absent means not known yet: never block on that.
   */
  kortixRunnable?: boolean;
}

export function planAction(choice: PlanChoice, access: ModelAccess): PlanAction {
  if (choice === 'kortix') {
    return access.hasKortixModels && access.kortixRunnable !== false ? 'open' : 'seePlans';
  }
  return access.hasOwnKey ? 'open' : 'addKey';
}

/**
 * `enabled` is stamped by the server; an absent flag means offered.
 *
 * On a gateway project every model sits under one provider, `kortix`, and the
 * real vendor is the model's own `provider`. A native project has no
 * `provider` field, so `providerID` is the vendor there.
 */
export function hasModelsFrom(
  models: readonly { providerID: string; provider?: string; enabled?: boolean }[],
): ModelAccess {
  const vendors = models.filter((m) => m.enabled !== false).map((m) => m.provider ?? m.providerID);
  return {
    hasKortixModels: vendors.includes('kortix'),
    hasOwnKey: vendors.some((vendor) => vendor !== 'kortix'),
  };
}
