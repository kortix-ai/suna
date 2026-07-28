'use client';

/**
 * The Settings tab strip: ONE flat underline row, no nested rails.
 *
 * A link list rather than a `Tabs` widget for the same reason
 * `ProjectSectionTabs` is — each tab is a real route, so ⌘-click, the back
 * button and deep links all behave.
 *
 * It deliberately renders no `<h1>`. The screen shell (`ProjectSectionPage`)
 * owns the title and the one-line description, and two headings stacked above
 * one tab row is exactly the duplication this screen is removing.
 */

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { SidebarPeekToggle } from '@/features/workspace/project-sidebar/sidebar-peek-toggle';
import { isLlmGatewayAvailable } from '@/lib/llm-gateway';
import {
  PROJECT_SETTINGS_TABS,
  type ProjectSettingsTab,
  projectSettingsHref,
} from '@/lib/project-nav';
import { cn } from '@/lib/utils';
import { getProjectDetail } from '@kortix/sdk';

export function SettingsTabStrip({
  projectId,
  active,
}: {
  projectId: string;
  active: ProjectSettingsTab;
}) {
  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  // Hide the LLM console unless the gateway is actually available to this
  // project — the same gate the old rail applied.
  const gatewayAvailable = isLlmGatewayAvailable(detail.data?.project);
  const tabs = PROJECT_SETTINGS_TABS.filter((tab) => tab.key !== 'models' || gatewayAvailable);

  return (
    <nav
      aria-label="Settings"
      className="border-border flex shrink-0 items-center gap-1 overflow-x-auto border-b px-4"
    >
      <SidebarPeekToggle className="mr-1" />
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={projectSettingsHref(projectId, tab.key)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative -mb-px shrink-0 border-b-2 px-2 py-2.5 text-sm transition-colors',
              isActive
                ? 'border-foreground text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default SettingsTabStrip;
