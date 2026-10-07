import type { SessionModelUsage } from '@kortix/sdk';
import { modelKeyToWire, type ModelKey } from '@kortix/sdk/react';

/**
 * What a session shows about the model that answered, from the gateway's
 * request record (`useSessionModelUsage`). The runtime transcript and the
 * composer name the model that was asked for. When the gateway answers from a
 * fallback model, those two differ, and so does the cost.
 */

/** A request's row is written as the request ends: how long after a turn ends its last row can still be missing. */
export const MODEL_USAGE_SETTLE_MS = 2_500;

interface NamedModel extends ModelKey {
  modelName: string;
}

/** A gateway wire id as the model picker names it; the id when the picker does not list it. */
export function modelNameOfWire(models: readonly NamedModel[] | undefined, wire: string): string {
  return models?.find((model) => modelKeyToWire(model) === wire)?.modelName?.trim() || wire;
}

export interface ServedModelNotice {
  /** Display name of the model that answered the newest request. */
  served: string;
  /** Display name of the model that did not answer. */
  fallbackFrom: string;
}

/**
 * The newest answer came from a fallback model in place of the model the
 * composer selects. Null once the composer selects another model: the next
 * request does not use the model that failed.
 */
export function servedModelNotice(
  usage: SessionModelUsage | undefined,
  selected: ModelKey | null | undefined,
  models: readonly NamedModel[] | undefined,
): ServedModelNotice | null {
  const latest = usage?.latest;
  if (!latest?.fallback_from) return null;
  if (selected && modelKeyToWire(selected) !== latest.fallback_from) return null;
  return {
    served: modelNameOfWire(models, latest.served_model),
    fallbackFrom: modelNameOfWire(models, latest.fallback_from),
  };
}

export interface TurnServedModel {
  /** Display names of the models that answered the turn, most requests first. */
  models: string[];
  fallbackFrom: string | null;
  /** What Kortix billed for the turn's model calls, in USD. */
  billedCost: number;
}

/** The models that answered one turn, keyed by the id of the prompt that started it. */
export function turnServedModel(
  usage: SessionModelUsage | undefined,
  messageId: string,
  models: readonly NamedModel[] | undefined,
): TurnServedModel | undefined {
  const turn = usage?.turns[messageId];
  if (!turn) return undefined;
  return {
    models: turn.served_models.map((wire) => modelNameOfWire(models, wire)),
    fallbackFrom: turn.fallback_from ? modelNameOfWire(models, turn.fallback_from) : null,
    billedCost: turn.billed_cost,
  };
}

/**
 * `turnServedModel` with one result per ledger entry. A refetch keeps the
 * identity of each turn that did not change, and the memoized turn row needs
 * the same from what it is given.
 */
export function turnServedModelResolver(models: readonly NamedModel[] | undefined) {
  const resolved = new WeakMap<object, TurnServedModel>();
  return (usage: SessionModelUsage | undefined, messageId: string): TurnServedModel | undefined => {
    const turn = usage?.turns[messageId];
    if (!turn) return undefined;
    let value = resolved.get(turn);
    if (!value) {
      value = turnServedModel(usage, messageId, models)!;
      resolved.set(turn, value);
    }
    return value;
  };
}

/**
 * What Kortix billed the session, when a fallback model answered any of its
 * turns. The transcript's own estimate prices every turn at the model that was
 * asked for, so it is wrong for exactly these sessions. Null keeps the estimate.
 */
export function sessionBilledCost(usage: SessionModelUsage | undefined): number | null {
  if (!usage) return null;
  const fellBack = Object.values(usage.turns).some((turn) => turn.fallback_from) || !!usage.latest?.fallback_from;
  return fellBack ? usage.billed_cost : null;
}
