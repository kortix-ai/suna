'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/view/settings-view';
import { ProjectSettingsTabs } from '@/features/workspace/project-section/project-settings-tabs';
import {
  DEFAULT_PROJECT_SETTINGS_TAB,
  PROJECT_SETTINGS_TABS,
  type ProjectSettingsTab,
  projectSettingsHref,
} from '@/lib/project-nav';

function parseTab(raw: string | undefined): ProjectSettingsTab | null {
  const match = PROJECT_SETTINGS_TABS.find((t) => t.key === raw);
  return match ? match.key : null;
}

function TabBody({ tab, projectId }: { tab: ProjectSettingsTab; projectId: string }) {
  switch (tab) {
    case 'general':
      return <SettingsView projectId={projectId} />;
    case 'members':
      return <MembersView projectId={projectId} />;
    case 'environment':
      return <SecretsView projectId={projectId} />;
    case 'repository':
      return <GitView projectId={projectId} />;
    case 'sandbox':
      return <SandboxView projectId={projectId} />;
    case 'models':
      return <LlmManagementView projectId={projectId} />;
    case 'upgrades':
      return <UpgradesView projectId={projectId} />;
    default:
      return null;
  }
}

export default function ProjectSettingsTabPage() {
  const params = useParams<{ id: string; tab: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params?.id ?? '';
  const tab = parseTab(params?.tab);

  // An unknown tab is a stale link, not a 404 — send it to General.
  useEffect(() => {
    if (projectId && !tab) {
      router.replace(projectSettingsHref(projectId, DEFAULT_PROJECT_SETTINGS_TAB));
    }
  }, [projectId, tab, router]);

  if (!projectId || !tab) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectSettingsTabs projectId={projectId} active={tab} />
      <div className="min-h-0 flex-1" key={`${tab}-${searchParams.get('llm') ?? ''}`}>
        <TabBody tab={tab} projectId={projectId} />
      </div>
    </div>
  );
}
