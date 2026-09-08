'use client';

import { notFound } from 'next/navigation';

import type { FeatureFlagKey } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';

import { CAPABILITY_TABS, type CapabilityTab } from './capability-tab-routes';

/** Read by the unconditional `useFeatureFlag` call below when a tab is ungated. */
const UNGATED_PROBE_KEY = 'templates' as const;

/**
 * The ROUTE half of a capability tab's feature-flag gate.
 *
 * `visibleCapabilityTabs` hides a flagged tab from the bar; this hides its
 * page from anyone who types the URL. Both read the SAME `flag:` field on the
 * same `CAPABILITY_TABS` entry — the caller passes a tab key, never a flag key
 * — so the bar and the route can never disagree about which flag gates what.
 *
 * Off resolves to `notFound()`, not a "feature disabled" panel: the flag
 * answers "does this project have the surface at all", and the answer is no.
 * `/projects/[id]/not-found.tsx` renders that inside the project shell, so the
 * sidebar and tab bar stay put. This matches `useFeatureFlag`'s own contract —
 * "A disabled feature's surface must be invisible, not merely inert."
 *
 * Returns `false` while the probe is in flight so the caller paints its
 * skeleton. Fail-closed after that, exactly like the bar: `enabled` is
 * `=== true`, and only a resolved `false` reaches `notFound()`, so a slow
 * `/projects/:id` never 404s a page the project does have.
 *
 * A tab with no `flag:` is ungated and always renders — passing one is a
 * harmless no-op, not an error, so this hook is safe on every capability page.
 * The hook still runs for that case (rules of hooks), reading an arbitrary key
 * off the project-detail cache it already shares; the result is discarded.
 */
export function useCapabilityTabFlag(projectId: string, tabKey: CapabilityTab['key']): boolean {
  const flag = capabilityTabFlag(tabKey);
  const { enabled, isLoading } = useFeatureFlag(projectId, flag ?? UNGATED_PROBE_KEY);
  const decision = capabilityFlagRouteDecision(flag, enabled, isLoading);

  if (decision === 'not-found') notFound();
  return decision === 'render';
}

/** The `flag:` a capability tab declares, or undefined when it is ungated. */
export function capabilityTabFlag(tabKey: CapabilityTab['key']): FeatureFlagKey | undefined {
  return CAPABILITY_TABS.find((tab) => tab.key === tabKey)?.flag;
}

/**
 * The gate's whole decision, as a pure function so it is testable without a
 * renderer. `wait` means the probe is in flight — paint the skeleton, never
 * 404 — and is the reason a slow `/projects/:id` cannot 404 a live page.
 */
export function capabilityFlagRouteDecision(
  flag: FeatureFlagKey | undefined,
  enabled: boolean,
  isLoading: boolean,
): 'render' | 'wait' | 'not-found' {
  if (!flag) return 'render';
  if (isLoading) return 'wait';
  return enabled ? 'render' : 'not-found';
}
