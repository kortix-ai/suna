'use client';

/**
 * Customize overlay — the single, full-screen surface for every per-project
 * config (Agents, Skills, Commands, Files, Connectors, Secrets, Channels,
 * Schedules, Webhooks, Members, Settings).
 *
 * Mounted once inside `ProjectShell`, it floats over the active project page as
 * a large modal (driven by `useCustomizeStore`) so opening it never swaps your
 * content area or spawns a tab — ESC / backdrop closes it and you land back
 * exactly where you were.
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ Customize · Project                         ✕  │
 *   ├──────────┬────────────────────────────────────┤
 *   │ Build    │                                     │
 *   │  Agents  │   active section content            │
 *   │  Skills  │   (each section owns its own        │
 *   │ Connect  │    list + detail layout)            │
 *   │  …       │                                     │
 *   │ Settings │                                     │
 *   └──────────┴────────────────────────────────────┘
 */

import { useMemo } from 'react';
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
  Terminal,
  Timer,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';

import { AgentsView } from '@/components/projects/customize/sections/agents-view';
import { ChannelsView } from '@/components/projects/customize/sections/channels-view';
import { CommandsView } from '@/components/projects/customize/sections/commands-view';
import { ComputersView } from '@/components/projects/customize/sections/computers-view';
import { ConnectorsView } from '@/components/projects/customize/sections/connectors-view';
import { MembersView } from '@/components/projects/customize/sections/members-view';
import { SandboxView } from '@/components/projects/customize/sections/sandbox-view';
import { SecretsView } from '@/components/projects/customize/sections/secrets-view';
import { SettingsView } from '@/components/projects/customize/sections/settings-view';
import { SkillsView } from '@/components/projects/customize/sections/skills-view';
import { TriggersView } from '@/components/projects/triggers-view';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useIsMobile } from '@/hooks/utils';
import { getProjectDetail } from '@/lib/projects-client';
import type { CustomizeSection } from '@/lib/customize-sections';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';

import { ChangesView } from './sections/changes-view';
import { DevView } from './sections/dev-view';
import { FilesSection } from './sections/files-section';

interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon;
  /** Render a text glyph instead of an icon (used for "/" → Commands). */
  glyph?: string;
}

interface RailGroup {
  label?: string;
  items: readonly RailItem[];
}

// Three scannable build/connect/automate blocks, with the workspace + admin
// surfaces (Changes, Files, Sandbox, Members, Settings) grouped in the footer.
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
];

const FOOTER_ITEMS: readonly RailItem[] = [
  { section: 'changes', label: 'Changes', icon: GitPullRequest },
  { section: 'files', label: 'Files', icon: FolderOpen },
  { section: 'sandbox', label: 'Sandbox', icon: Container },
  { section: 'dev', label: 'Dev', icon: Terminal },
  { section: 'members', label: 'Members', icon: Users },
  { section: 'settings', label: 'Settings', icon: Settings },
];

// Experimental Agent Computer Tunnel — only shown in the rail when the project
// has opted in (Customize → Settings → Experimental). Slots into "Connect".
const COMPUTERS_ITEM: RailItem = { section: 'computers', label: 'Computers', icon: Monitor };

/** Build the rail groups for this project, injecting flag-gated entries. */
function railGroups(tunnelEnabled: boolean): readonly RailGroup[] {
  if (!tunnelEnabled) return GROUPS;
  return GROUPS.map((g) =>
    g.label === 'Connect' ? { ...g, items: [...g.items, COMPUTERS_ITEM] } : g,
  );
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

  // Flag-gated rail. Computers (Agent Computer Tunnel) appears only when this
  // project has opted into the experimental feature.
  const tunnelEnabled = detail.data?.project?.experimental?.agent_tunnel ?? false;
  const groups = useMemo(() => railGroups(tunnelEnabled), [tunnelEnabled]);
  const allItems = useMemo(
    () => [...groups.flatMap((g) => g.items), ...FOOTER_ITEMS],
    [groups],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        onInteractOutside={(event) => {
          // The file preview (and any nested overlay) portals to <body>, outside
          // this dialog's DOM, so Radix treats a click/focus on it as "outside"
          // and would close Customize. Keep Customize open when the interaction
          // targets such an overlay — it closes itself (X / backdrop / Esc).
          const target = event.detail.originalEvent.target as Element | null;
          // The Pipedream Connect SDK appends its overlay <iframe> to <body>,
          // outside this dialog. Interacting with it must not close Customize.
          if (
            target?.closest('[data-file-preview-overlay]') ||
            target?.closest('iframe[id^="pipedream-connect-iframe-"]')
          ) {
            event.preventDefault();
          }
        }}
        className={cn(
          'flex flex-col gap-0 overflow-hidden p-0',
          // Edge-to-edge full-screen page: fills the viewport with no margin,
          // square corners, and no border — opens like a dialog but reads as a
          // real full-screen surface over everything (X / Esc closes).
          'h-[100dvh] w-screen max-w-none rounded-none border-0 shadow-none sm:max-w-none',
        )}
      >
        <DialogTitle className="sr-only">
          Customize {projectName || 'project'}
        </DialogTitle>

        {/* Header. `kx-customize-header` indents the title past the OS window
            controls on desktop (macOS traffic lights left; Win/Linux controls
            right) without adding vertical space. No-op on the web. */}
        <div className="kx-customize-header flex h-12 shrink-0 items-center justify-between border-b border-border/60 pl-4 pr-2">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">Customize</span>
            {projectName && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="truncate text-muted-foreground">{projectName}</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {isMobile ? (
            <nav
              aria-label="Customize"
              className="w-full shrink-0 border-b border-border/60 bg-background"
            >
              <ul className="flex items-center gap-1 overflow-x-auto px-2 py-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
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
              className="flex w-[196px] shrink-0 flex-col border-r border-border/60 bg-muted/20"
            >
              <div className="flex-1 overflow-y-auto px-2.5 py-3 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                {groups.map((group, idx) => (
                  <div key={group.label ?? idx} className={idx > 0 ? 'mt-4' : undefined}>
                    {group.label && (
                      <div className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground/50">
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
              <div className="border-t border-border/50 px-2.5 py-2.5">
                <ul className="space-y-0.5">
                  {FOOTER_ITEMS.map((item) => (
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
            </nav>
          )}

          <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
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
        horizontal ? 'whitespace-nowrap px-3 py-2' : 'w-full px-2.5 py-1.5 text-left',
        // On-brand selected state: tinted primary (themed), never a flat grey
        // or floating card chip. Hover stays a soft neutral wash.
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

function SectionContent({
  section,
  projectId,
}: {
  section: CustomizeSection;
  projectId: string;
}) {
  // Each branch is a separate component instance, so switching sections tears
  // down the previous tree (matches the per-route behavior the legacy pages
  // had).
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
