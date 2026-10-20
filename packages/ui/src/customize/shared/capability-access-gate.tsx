'use client';

import { uiRoutes } from '../../lib/routes';
import { useEffect, type ReactNode } from 'react';
import { useUiPathname, useUiRouter } from '../../providers/ui-provider';

import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import type { CanResult } from '../../internal/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';
import { FeatureGateScreen } from './feature-gate-screen';
import { useTranslations } from '../../i18n';

import { CapabilitiesSkeleton } from './capability-skeleton';
import { activeCapabilityTab, capabilityTabHref } from '../../internal/lib/capability-tab-routes';

/** True only for a verdict the engine actually returned. A probe in flight or
 *  a failed probe is not a denial. */
export function receivedDenial(result: CanResult | undefined): boolean {
  return !!result && !result.isLoading && !result.isError && !result.allowed;
}

/**
 * Permission gate for the body of a Customize tab.
 *
 * The page renders only once `capabilityAccess()` has settled AND lists the
 * tab. A tab the caller may not open never renders — not even for the beat
 * before the probe lands, which used to be long enough for the page's own
 * requests to 403 into a "No access" card. A typed or bookmarked URL to such a
 * tab is replaced with the first tab the caller may open, or the project home
 * when there is none: no dead end (KRTX-2144).
 */
export function CapabilityAccessGate({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const pathname = useUiPathname();
  const router = useUiRouter();
  const { settled, tabs } = useCapabilityAccess(projectId);
  const key = activeCapabilityTab(pathname);
  const reminders = useFeatureFlag(projectId, 'reminders');
  const t = useTranslations('reminders');
  // Bookmarked flag-off Reminders links explain the gate instead of landing
  // on an unrelated tab. Never mount the inventory while access is denied.
  const remindersDisabled = key === 'reminders' && !reminders.isLoading && !reminders.enabled;
  const allowed = !key || tabs.includes(key);

  useEffect(() => {
    if (!settled || allowed || remindersDisabled) return;
    router.replace(tabs[0] ? capabilityTabHref(projectId, tabs[0]) : uiRoutes().project(projectId));
  }, [settled, allowed, remindersDisabled, tabs, projectId, router]);

  // `/customize` itself (no tab) is a redirect page that waits on its own.
  if (!key) return children;
  if (settled && remindersDisabled) {
    return <FeatureGateScreen featureName={t('title')} description={t('gateDescription')} />;
  }
  if (settled && allowed) return children;
  return <CapabilitiesSkeleton />;
}
