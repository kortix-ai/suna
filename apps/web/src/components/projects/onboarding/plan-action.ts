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
}

export function planAction(choice: PlanChoice, access: ModelAccess): PlanAction {
  if (choice === 'kortix') return access.hasKortixModels ? 'open' : 'seePlans';
  return access.hasOwnKey ? 'open' : 'addKey';
}

/** `enabled` is stamped by the server; an absent flag means offered. */
export function hasModelsFrom(
  models: readonly { providerID: string; enabled?: boolean }[],
): ModelAccess {
  const offered = models.filter((m) => m.enabled !== false);
  return {
    hasKortixModels: offered.some((m) => m.providerID === 'kortix'),
    hasOwnKey: offered.some((m) => m.providerID !== 'kortix'),
  };
}
