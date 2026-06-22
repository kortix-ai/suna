'use client';

import { MarketplaceView } from '@/components/marketplace/marketplace-view';
import { TriggersView } from '@/components/projects/triggers-view';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AgentsView } from '@/features/workspace/customize/sections/agents-view';
import { ChannelsView } from '@/features/workspace/customize/sections/channels-view';
import { CommandsView } from '@/features/workspace/customize/sections/commands-view';
import { ComputersView } from '@/features/workspace/customize/sections/computers-view';
import { ConnectorsView } from '@/features/workspace/customize/sections/connectors-view';
import { MembersView } from '@/features/workspace/customize/sections/members-view';
import { SandboxView } from '@/features/workspace/customize/sections/sandbox-view';
import { SecretsView } from '@/features/workspace/customize/sections/secrets-view';
import { SettingsView } from '@/features/workspace/customize/sections/settings-view';
import { SkillsView } from '@/features/workspace/customize/sections/skills-view';
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
  SlidersHorizontal,
  Sparkles,
  Store,
  Terminal,
  Timer,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';

import { ChangesView } from './sections/changes-view';
import { DevView } from './sections/dev-view';
import { FilesSection } from './sections/files-section';

interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon;
  glyph?: string;
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
      { section: 'commands', label: 'Commands', glyph: '/' },
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

// Experimental Agent Computer Tunnel — only shown in the rail when the project
// has opted in (Customize → Settings → Experimental). Slots into "Connect".
const COMPUTERS_ITEM: RailItem = { section: 'computers', label: 'Computers', icon: Monitor };

// Experimental Marketplace — browse + install skills. Opt-in (Customize →
// Settings → Experimental); slots into "Build" right after Commands.
const MARKETPLACE_ITEM: RailItem = { section: 'marketplace', label: 'Marketplace', icon: Store };

/** Build the rail groups for this project, injecting flag-gated entries. */
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

export function CustomizeOverlay({ projectId }: { projectId: string }) {
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
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        onInteractOutside={(event) => {
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
          'h-dvh w-screen max-w-none rounded-none border-0 shadow-none sm:max-w-none sm:rounded-none',
        )}
      >
        <DialogTitle className="sr-only">Customize {projectName || 'project'}</DialogTitle>

        <div className="kx-customize-header border-border/60 flex h-12 shrink-0 items-center justify-between border-b pr-2 pl-4">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <SlidersHorizontal className="text-muted-foreground size-4 shrink-0" />
            <span className="text-foreground font-medium">Customize</span>
            {projectName && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground truncate">{projectName}</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-lg transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {isMobile ? (
            <nav
              aria-label="Customize"
              className="border-border/60 bg-background w-full shrink-0 border-b"
            >
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
            <nav
              aria-label="Customize"
              className="border-border/60 bg-muted/20 flex w-[196px] shrink-0 flex-col border-r"
            >
              <div className="flex-1 [scrollbar-width:none] overflow-y-auto px-2.5 py-3 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                {groups.map((group, idx) => (
                  <div key={group.label ?? idx} className={idx > 0 ? 'mt-4' : undefined}>
                    {group.label && (
                      <div className="text-muted-foreground/50 px-2 pb-1.5 text-xs font-medium tracking-wider uppercase">
                        {group.label}
                      </div>
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
          )}

          <main className="bg-background min-h-0 min-w-0 flex-1 overflow-hidden">
            {open && <SectionContent section={section} projectId={projectId} />}
          </main>
        </div>
      </DialogContent>
    </Dialog>
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
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex cursor-pointer items-center gap-2.5 rounded-lg text-sm font-medium transition-colors',
        horizontal ? 'px-3 py-2 whitespace-nowrap' : 'w-full px-2.5 py-1.5 text-left',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {item.glyph ? (
        <span
          aria-hidden
          className={cn(
            'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-xs leading-none',
            active ? 'text-foreground' : 'text-muted-foreground/70',
          )}
        >
          {item.glyph}
        </span>
      ) : Icon ? (
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            active ? 'text-foreground' : 'text-muted-foreground/70',
          )}
        />
      ) : null}
      <span className={cn(!horizontal && 'truncate')}>{item.label}</span>
    </button>
  );
}

function SectionContent({ section, projectId }: { section: CustomizeSection; projectId: string }) {
  switch (section) {
    case 'changes':
      return <ChangesView projectId={projectId} />;
    case 'files':
      return <FilesSection projectId={projectId} />;
    case 'skills':
      return <SkillsView projectId={projectId} />;
    case 'agents':
      return <AgentsView projectId={projectId} />;
    case 'commands':
      return <CommandsView projectId={projectId} />;
    case 'marketplace':
      return <MarketplaceView projectId={projectId} />;
    case 'secrets':
      return <SecretsView projectId={projectId} />;
    case 'connectors':
      return <ConnectorsView projectId={projectId} />;
    case 'computers':
      return <ComputersView projectId={projectId} />;
    case 'members':
      return <MembersView projectId={projectId} />;
    case 'schedules':
      return <TriggersView projectId={projectId} type="cron" />;
    case 'webhooks':
      return <TriggersView projectId={projectId} type="webhook" />;
    case 'channels':
      return <ChannelsView projectId={projectId} />;
    case 'sandbox':
      return <SandboxView projectId={projectId} />;
    case 'dev':
      return <DevView projectId={projectId} />;
    case 'settings':
      return <SettingsView projectId={projectId} />;
    default:
      return null;
  }
}
