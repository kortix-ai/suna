import type { AuthedPrincipal, GatewayAttemptFailure } from '../domain';

/**
 * A caller's routed model that could not serve, and the fallback model that
 * did. While it is held, the caller's requests start at that fallback and try
 * the routed model last, so one session does not fail over again on every
 * request or flip between two models while the routed model is resting.
 */
export interface HeldRoute {
  fallbackModel: string;
  failure: GatewayAttemptFailure;
  /** The routed model is an own key or ChatGPT plan (billing `none`). */
  byok: boolean;
}

/** A ChatGPT plan's usage limit lasts days: probe the routed model again after this. */
export const MAX_HOLD_SECONDS = 600;
/** A transient upstream failure (429, 5xx, model busy) that a fallback answered. */
export const DISPATCH_HOLD_SECONDS = 60;
/** A login that needs reconnection, or a model this deployment no longer serves. */
export const SETUP_HOLD_SECONDS = 60;
const MAX_ENTRIES = 20_000;

// ponytail: replica-local. Each gateway task learns a resting model on its own
// first failure, one extra attempt per task per hold. Shared state only if that
// cost is measured.
export function createRouteMemory(now: () => number = Date.now) {
  const held = new Map<string, HeldRoute & { until: number }>();
  return {
    hold(key: string, route: HeldRoute, seconds: number): void {
      held.delete(key);
      // Map iteration is insertion order: the first key is the oldest hold.
      if (held.size >= MAX_ENTRIES) held.delete(held.keys().next().value!);
      held.set(key, { ...route, until: now() + Math.min(seconds, MAX_HOLD_SECONDS) * 1000 });
    },
    recall(key: string): HeldRoute | undefined {
      const route = held.get(key);
      if (route && route.until > now()) return route;
      held.delete(key);
      return undefined;
    },
    release(key: string): void {
      held.delete(key);
    },
  };
}

export type RouteMemory = ReturnType<typeof createRouteMemory>;

/** One session (else one gateway key, else one user) in one project, per routed model. */
export function routeMemoryKey(principal: AuthedPrincipal, routeModel: string): string {
  const caller = principal.sessionId ?? principal.keyId ?? principal.userId;
  return [principal.accountId, principal.projectId ?? '', caller, routeModel].join('\u0000');
}
