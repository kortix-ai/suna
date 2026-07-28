'use client';

/**
 * Settings: one flat tab strip, one screen per tab.
 *
 * There is no rail and no nested tab bar. `SettingsTabStrip` is the only
 * navigation on the screen, and the header — the `<h1>` and its single line of
 * description — comes from `ProjectSectionPage` via `settings-tab-meta`, so a
 * tab body renders only its body.
 *
 * Five bodies still predate that split (`bodyOwnsHeader`): Members,
 * Environment, Sandbox, Models and Upgrades each still render their own
 * `CustomizeSectionWrapper` heading. Wrapping those in `ProjectSectionPage`
 * today would stack two titles and nest two scroll containers, so they render
 * under the same strip with their own header until they are migrated. Every tab
 * still resolves to exactly the view it always did.
 */

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { UpgradesView } from '@/features/workspace/customize/migrate-to-v2/upgrade-view';
import { LlmManagementView } from '@/features/workspace/customize/sections/gateway-view';
import { GitView } from '@/features/workspace/customize/sections/view/git-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/view/settings-view';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';
import { settingsTabMeta } from '@/features/workspace/settings/settings-tab-meta';
import { SettingsTabStrip } from '@/features/workspace/settings/settings-tab-strip';
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

  const meta = settingsTabMeta(tab);
  const bodyKey = `${tab}-${searchParams.get('llm') ?? ''}`;
  const strip = <SettingsTabStrip projectId={projectId} active={tab} />;

  if (meta.bodyOwnsHeader) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {strip}
        <div className="min-h-0 flex-1" key={bodyKey}>
          <TabBody tab={tab} projectId={projectId} />
        </div>
      </div>
    );
  }

  return (
    <ProjectSectionPage
      navTabs={strip}
      title={meta.title}
      description={meta.description}
      state="ready"
      key={bodyKey}
    >
      <TabBody tab={tab} projectId={projectId} />
    </ProjectSectionPage>
  );
}
