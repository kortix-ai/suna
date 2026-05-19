'use client';

/**
 * Outer category rail for the Customize page.
 *
 * Lists the top-level surfaces (Files, Skills, Agents, Commands, Secrets,
 * Schedules, Webhooks, Channels, Settings). Clicking a row updates the
 * `?section=` search param so the active selection is bookmarkable and
 * survives a refresh.
 */

import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bot,
  FolderOpen,
  KeyRound,
  MessageSquare,
  Settings,
  Sparkles,
  Timer,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  type CustomizeSection,
  DEFAULT_CUSTOMIZE_SECTION,
  parseCustomizeSection,
} from '@/lib/customize-sections';

interface RailItem {
  section: CustomizeSection;
  label: string;
  icon?: LucideIcon;
  /** Render a single text glyph instead of an icon (used for "/" → Commands). */
  glyph?: string;
}

const PRIMARY_ITEMS: readonly RailItem[] = [
  { section: 'files',     label: 'Files',     icon: FolderOpen },
  { section: 'skills',    label: 'Skills',    icon: Sparkles },
  { section: 'agents',    label: 'Agents',    icon: Bot },
  { section: 'commands',  label: 'Commands',  glyph: '/' },
  { section: 'secrets',   label: 'Secrets',   icon: KeyRound },
  { section: 'schedules', label: 'Schedules', icon: Timer },
  { section: 'webhooks',  label: 'Webhooks',  icon: Webhook },
  { section: 'channels',  label: 'Channels',  icon: MessageSquare },
];

const FOOTER_ITEMS: readonly RailItem[] = [
  { section: 'settings', label: 'Settings', icon: Settings },
];

export function CustomizeRail({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const active = useMemo(
    () =>
      parseCustomizeSection(searchParams.get('section')) ?? DEFAULT_CUSTOMIZE_SECTION,
    [searchParams],
  );

  const go = (section: CustomizeSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('section', section);
    router.replace(`/projects/${projectId}/customize?${params.toString()}`, {
      scroll: false,
    });
  };

  return (
    <nav
      aria-label="Customize"
      className="flex h-full w-[220px] shrink-0 flex-col border-r border-border/60 bg-background"
    >
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {PRIMARY_ITEMS.map((item) => (
            <li key={item.section}>
              <RailButton
                item={item}
                active={active === item.section}
                onClick={() => go(item.section)}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border/40 px-2 py-2">
        <ul className="space-y-0.5">
          {FOOTER_ITEMS.map((item) => (
            <li key={item.section}>
              <RailButton
                item={item}
                active={active === item.section}
                onClick={() => go(item.section)}
              />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function RailButton({
  item,
  active,
  onClick,
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] font-medium transition-colors',
        active
          ? 'bg-muted/70 text-foreground'
          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-foreground"
        />
      )}
      {item.glyph ? (
        <span
          aria-hidden
          className={cn(
            'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center font-mono text-[12px] leading-none',
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
      <span className="truncate">{item.label}</span>
    </button>
  );
}
