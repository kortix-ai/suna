'use client';

/**
 * The Settings tab strip.
 *
 * One flat row. Everything that is not one of the four promoted sections lives
 * behind one of these tabs — the four-group rail is gone.
 */

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { isLlmGatewayAvailable } from '@/lib/llm-gateway';
import {
  PROJECT_SETTINGS_TABS,
  type ProjectSettingsTab,
  projectSettingsHref,
} from '@/lib/project-nav';
import { cn } from '@/lib/utils';
import { getProjectDetail } from '@kortix/sdk';

export function ProjectSettingsTabs({
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
  // project — same gate the rail used.
  const gatewayAvailable = isLlmGatewayAvailable(detail.data?.project);
  const tabs = PROJECT_SETTINGS_TABS.filter((t) => t.key !== 'models' || gatewayAvailable);

  return (
    <div className="border-border shrink-0 border-b px-4">
      <div className="flex items-center gap-2 pt-4">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Settings</h1>
      </div>
      <nav aria-label="Settings" className="mt-3 flex items-center gap-1 overflow-x-auto">
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
    </div>
  );
}

export default ProjectSettingsTabs;
