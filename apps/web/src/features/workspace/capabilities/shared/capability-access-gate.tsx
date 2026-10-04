'use client';

import { LockKeyIcon } from '@phosphor-icons/react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { EmptyState } from '@/features/layout/section/empty-state';
import { TAB_PREFERENCE } from '@/features/workspace/project-sidebar/project-settings-nav';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans, type CanResult } from '@/lib/use-project-can';

import { activeCapabilityTab, type CapabilityTab } from './capability-tab-routes';

/** True only for a verdict the engine actually returned. A probe in flight or
 *  a failed probe is not a denial: the page renders, and the API still
 *  refuses anything the caller may not read. */
export function receivedDenial(result: CanResult | undefined): boolean {
  return !!result && !result.isLoading && !result.isError && !result.allowed;
}

/**
 * Whether the caller is denied the tab `key`. Two gates, both from
 * `TAB_PREFERENCE` so the sidebar row and this gate never disagree:
 * `project.customize.read` for the whole surface, then the tab's own leaf.
 */
export function capabilityTabDenied(
  caps: Record<string, CanResult>,
  key: CapabilityTab['key'],
): boolean {
  if (receivedDenial(caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ])) return true;
  const pref = TAB_PREFERENCE.find((tab) => tab.key === key);
  return !!pref && receivedDenial(caps[pref.action]);
}

/**
 * Permission gate for the body of a Customize tab — never for the tab bar.
 *
 * The bar is static: it paints every tab on the first frame, so nothing in it
 * moves when the probe lands. Access is decided here, one level down, in the
 * content area only. The page renders while the probe is in flight (the
 * verdict is usually already cached by the sidebar, which reads the same
 * `PROJECT_PAGE_ACTIONS` batch), and is replaced by a no-access state only on
 * a denial the engine returned.
 */
export function CapabilityAccessGate({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const caps = useProjectPageCans(projectId);
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const key = activeCapabilityTab(pathname);

  if (!key || !capabilityTabDenied(caps, key)) return children;

  return (
    <div className="flex min-h-0 flex-1" data-slot="capability-no-access">
      <EmptyState
        size="sm"
        icon={LockKeyIcon}
        title={tI18nComplete.raw('textabb84be05cfa')}
        description={tI18nComplete.raw('text516f7c6c91fd')}
      />
    </div>
  );
}
