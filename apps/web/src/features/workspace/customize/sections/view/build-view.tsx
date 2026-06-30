'use client';

/**
 * Build — one Customize section that consolidates Agents, Skills, and Commands
 * behind a single tab bar. Deep-links (`openCustomize('skills')`, route
 * `/customize/commands`, project-home tiles) set the store section, which we
 * follow to pick the active tab. In-view tab clicks sync the store section so
 * reopening returns to the last sub-tab.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarketplaceSectionButton } from '@/features/workspace/customize/marketplace-section-button';
import { AgentsView } from '@/features/workspace/customize/sections/view/agents-view';
import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';
import { SkillsView } from '@/features/workspace/customize/sections/view/skills-view';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import type { CustomizeSection } from '@/lib/customize-sections';
import { CUSTOMIZE_SECTION_ACCESS } from '@/lib/project-actions';
import { useProjectCans } from '@/lib/use-project-can';
import { useCustomizeStore } from '@/stores/customize-store';
import { Command, Sparkles } from '@mynaui/icons-react';
import { Bot, Plus } from 'lucide-react';
import Link from 'next/link';
import { type ComponentType, useEffect, useMemo, useState } from 'react';

type BuildTab = 'agents' | 'skills' | 'commands';

type TabIcon = ComponentType<{ className?: string }>;

type BuildTabMeta = {
  id: BuildTab;
  label: string;
  icon: TabIcon;
  title: string;
  description: string;
  docs?: string;
};

const BUILD_TABS: BuildTabMeta[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    title: 'Agents',
    description: 'Pick an agent from the list to preview it, or create a new one.',
    docs: 'https://kortix.com/docs/concepts/agents',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: Sparkles,
    title: 'Skills',
    description: 'Pick a skill from the list to preview it, or create a new one.',
  },
  {
    id: 'commands',
    label: 'Commands',
    icon: Command,
    title: 'Commands',
    description: 'Pick a command from the list to preview it, or create a new one.',
  },
];

const TAB_BY_SECTION: Partial<Record<CustomizeSection, BuildTab>> = {
  agents: 'agents',
  skills: 'skills',
  commands: 'commands',
};

export function isBuildSection(section: CustomizeSection): section is BuildTab {
  return section === 'agents' || section === 'skills' || section === 'commands';
}

export function BuildView({ projectId }: { projectId: string }) {
  const section = useCustomizeStore((s) => s.section);
  const setSection = useCustomizeStore((s) => s.setSection);
  const [tab, setTab] = useState<BuildTab>(() => TAB_BY_SECTION[section] ?? 'agents');

  const caps = useProjectCans(projectId, [
    CUSTOMIZE_SECTION_ACCESS.agents.read,
    CUSTOMIZE_SECTION_ACCESS.skills.read,
    CUSTOMIZE_SECTION_ACCESS.commands.read,
  ]);

  const allowedTabs = useMemo(() => {
    return BUILD_TABS.filter((t) => {
      const readAction = CUSTOMIZE_SECTION_ACCESS[t.id].read;
      const cap = caps[readAction];
      if (!cap || cap.isLoading || cap.isError) return true;
      return cap.allowed === true;
    });
  }, [caps]);

  const configure = useConfigureThread(projectId);

  const activeTab = useMemo(() => {
    if (allowedTabs.some((t) => t.id === tab)) return tab;
    return allowedTabs[0]?.id ?? 'agents';
  }, [tab, allowedTabs]);

  useEffect(() => {
    const next = TAB_BY_SECTION[section];
    if (next && allowedTabs.some((t) => t.id === next)) {
      setTab(next);
    }
  }, [section, allowedTabs]);

  useEffect(() => {
    if (activeTab === tab) return;
    setTab(activeTab);
    if (isBuildSection(activeTab)) {
      setSection(activeTab);
    }
  }, [activeTab, tab, setSection]);

  const onTabChange = (value: string) => {
    const next = value as BuildTab;
    setTab(next);
    setSection(next);
  };

  const newKind = activeTab === 'agents' ? 'agent' : activeTab === 'skills' ? 'skill' : 'command';
  const activeMeta = BUILD_TABS.find((t) => t.id === activeTab) ?? BUILD_TABS[0];

  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="bg-background flex h-full min-h-0 flex-col gap-0"
    >
      <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2">
        <TabsList animate="none" size="sm">
          {allowedTabs.map((t) => {
            return (
              <TabsTrigger key={t.id} value={t.id} className="w-fit flex-none">
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="flex shrink-0 items-center gap-1.5 pb-2">
          <MarketplaceSectionButton projectId={projectId} />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => configure.start(newConfigPrompt(newKind))}
            disabled={configure.pending}
          >
            {configure.pending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Plus className="size-4" />
            )}
            New
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-10 pb-20 lg:py-20 lg:pt-16">
          <header className="space-y-1">
            <h2 className="text-foreground text-xl font-medium">{activeMeta.title}</h2>
            <span className="flex items-center gap-1">
              <p className="text-muted-foreground text-sm text-balance">{activeMeta.description}</p>
              {activeMeta.docs ? (
                <Button variant="transparent" className="m-0 p-0" asChild>
                  <Link href={activeMeta.docs} target="_blank" rel="noopener noreferrer">
                    Learn more.
                  </Link>
                </Button>
              ) : null}
            </span>
          </header>

          <TabsContent value="agents">
            <AgentsView projectId={projectId} embedded />
          </TabsContent>
          <TabsContent value="skills">
            <SkillsView projectId={projectId} embedded />
          </TabsContent>
          <TabsContent value="commands">
            <CommandsView projectId={projectId} embedded />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
