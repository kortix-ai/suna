'use client';

import { MarketplaceView } from '@/components/marketplace/marketplace-view';
import { ScheduleView } from '@/components/projects/schedule-view';
import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalTitle } from '@/components/ui/modal';
import { ConnectorsView } from '@/features/workspace/customize/sections/connectors-view';
import { AgentsView } from '@/features/workspace/customize/sections/view/agents-view';
import { ChannelsView } from '@/features/workspace/customize/sections/view/channels-view';
import { CommandsView } from '@/features/workspace/customize/sections/view/commands-view';
import { ComputersView } from '@/features/workspace/customize/sections/view/computers-view';
import { MembersView } from '@/features/workspace/customize/sections/view/members-view';
import { SandboxView } from '@/features/workspace/customize/sections/view/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/view/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/view/settings-view';
import { SkillsView } from '@/features/workspace/customize/sections/view/skills-view';
import { useIsMobile } from '@/hooks/utils';
import type { CustomizeSection } from '@/lib/customize-sections';
import { getProjectDetail } from '@/lib/projects-client';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Container,
  FolderOpen,
  GitPullRequest,
  KeyRound,
  MessageSquare,
  Monitor,
  Plug,
  Settings,
  Slash,
  Sparkles,
  Store,
  Terminal,
  Timer,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';

import { Label } from '@/components/ui/label';
import { ArrowLeft } from '@mynaui/icons-react';
import { FilesSection } from './sections/files-section';
import { ChangesView } from './sections/view/changes-view';
import { DevView } from './sections/view/dev-view';

interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon;
}

interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}

const GROUPS: readonly RailGroup[] = [
  {
    label: 'Build',
    items: [
      { section: 'agents', label: 'Agents', icon: Bot },
      { section: 'skills', label: 'Skills', icon: Sparkles },
      { section: 'commands', label: 'Commands', icon: Slash },
    ],
  },
  {
    label: 'Connect',
    items: [
      { section: 'connectors', label: 'Connectors', icon: Plug },
      { section: 'secrets', label: 'Secrets', icon: KeyRound },
      { section: 'channels', label: 'Channels', icon: MessageSquare },
    ],
  },
  {
    label: 'Automate',
    items: [
      { section: 'schedules', label: 'Schedules', icon: Timer },
      { section: 'webhooks', label: 'Webhooks', icon: Webhook },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { section: 'changes', label: 'Changes', icon: GitPullRequest },
      { section: 'files', label: 'Files', icon: FolderOpen },
      { section: 'sandbox', label: 'Sandbox', icon: Container },
      { section: 'dev', label: 'Dev', icon: Terminal },
    ],
  },
  {
    label: 'Manage',
    items: [
      { section: 'members', label: 'Members', icon: Users },
      { section: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

const COMPUTERS_ITEM: RailItem = { section: 'computers', label: 'Computers', icon: Monitor };

const MARKETPLACE_ITEM: RailItem = { section: 'marketplace', label: 'Marketplace', icon: Store };

function railGroups(tunnelEnabled: boolean, marketplaceEnabled: boolean): readonly RailGroup[] {
  return GROUPS.map((g) => {
    if (g.label === 'Build' && marketplaceEnabled) {
      return { ...g, items: [...g.items, MARKETPLACE_ITEM] };
    }
    if (g.label === 'Connect' && tunnelEnabled) {
      return { ...g, items: [...g.items, COMPUTERS_ITEM] };
    }
    return g;
  });
}

export function CustomizPanel({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  const section = useCustomizeStore((s) => s.section);
  const setSection = useCustomizeStore((s) => s.setSection);
  const close = useCustomizeStore((s) => s.close);
  const isMobile = useIsMobile();

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: open && !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const projectName = detail.data?.project?.name ?? '';

  const tunnelEnabled = detail.data?.project?.experimental?.agent_tunnel ?? false;
  const marketplaceEnabled = detail.data?.project?.experimental?.marketplace ?? false;
  const groups = useMemo(
    () => railGroups(tunnelEnabled, marketplaceEnabled),
    [tunnelEnabled, marketplaceEnabled],
  );
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  return (
    <Modal open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <ModalContent
        showCloseButton={false}
        variant="base"
        aria-describedby={undefined}
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target as Element | null;
          if (
            target?.closest('[data-file-preview-overlay]') ||
            target?.closest('iframe[id^="pipedream-connect-iframe-"]')
          ) {
            event.preventDefault();
          }
        }}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          'inset-0 top-0 left-0 h-dvh min-h-dvh w-screen max-w-none translate-x-0 translate-y-0 space-y-0 rounded-none border-0 shadow-none sm:max-w-none sm:rounded-none lg:top-0 lg:left-0 lg:h-dvh lg:min-h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0',
        )}
      >
        <ModalTitle className="sr-only">Customize {projectName || 'project'}</ModalTitle>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[250px_1fr]">
          {isMobile ? (
            <nav aria-label="Customize" className="border-border/60 bg-background border-b">
              <ul className="flex [scrollbar-width:none] items-center gap-1 overflow-x-auto px-2 py-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {allItems.map((item) => (
                  <li key={item.section} className="shrink-0">
                    <RailButton
                      item={item}
                      active={section === item.section}
                      onClick={() => setSection(item.section)}
                      orientation="horizontal"
                    />
                  </li>
                ))}
              </ul>
            </nav>
          ) : (
            <section className="bg-sidebar flex min-h-0 flex-col space-y-10 border-r py-4">
              <div className="w-full px-2.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground flex w-full items-center justify-start gap-2 px-4 py-2 text-left text-sm font-medium"
                >
                  <ArrowLeft />
                  Back to workspace
                </Button>
              </div>

              <nav aria-label="Customize">
                <div className="flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                  {groups.map((group, idx) => (
                    <div
                      key={group.label ?? idx}
                      className={cn('space-y-1', idx > 0 ? 'mt-4' : undefined)}
                    >
                      {group.label && (
                        <Label className="text-muted-foreground px-2 pb-1">{group.label}</Label>
                      )}
                      <ul className="space-y-0.5">
                        {group.items.map((item) => (
                          <li key={item.section}>
                            <RailButton
                              item={item}
                              active={section === item.section}
                              onClick={() => setSection(item.section)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </nav>
            </section>
          )}

          <main className="bg-background flex min-h-0 min-w-0 flex-col overflow-hidden">
            {open && <SectionContent section={section} projectId={projectId} />}
          </main>
        </div>
      </ModalContent>
    </Modal>
  );
}

function RailButton({
  item,
  active,
  onClick,
  orientation = 'vertical',
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
  orientation?: 'vertical' | 'horizontal';
}) {
  const Icon = item.icon;
  const horizontal = orientation === 'horizontal';
  return (
    <Button
      type="button"
      variant={active ? 'accent' : 'ghost'}
      size="sm"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('w-full justify-start gap-2.5 text-left')}
    >
      {Icon && <Icon className={cn('size-3.5 shrink-0')} />}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
    </Button>
  );
}

function SectionContent({ section, projectId }: { section: CustomizeSection; projectId: string }) {
  switch (section) {
    case 'agents':
      return <AgentsView projectId={projectId} />;
    case 'skills':
      return <SkillsView projectId={projectId} />;
    case 'commands':
      return <CommandsView projectId={projectId} />;
    case 'marketplace':
      return <MarketplaceView projectId={projectId} />;
    case 'connectors':
      return <ConnectorsView projectId={projectId} />;
    case 'secrets':
      return <SecretsView projectId={projectId} />;
    case 'channels':
      return <ChannelsView projectId={projectId} />;
    case 'computers':
      return <ComputersView projectId={projectId} />;
    case 'schedules':
      return <ScheduleView projectId={projectId} type="cron" />;
    case 'webhooks':
      return <ScheduleView projectId={projectId} type="webhook" />;
    case 'changes':
      return <ChangesView projectId={projectId} />;
    case 'files':
      return <FilesSection projectId={projectId} />;
    case 'sandbox':
      return <SandboxView projectId={projectId} />;
    case 'dev':
      return <DevView projectId={projectId} />;
    case 'members':
      return <MembersView projectId={projectId} />;
    case 'settings':
      return <SettingsView projectId={projectId} />;
    default:
      return null;
  }
}
