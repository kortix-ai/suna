'use client';

/**
 * Secondary navigation column inside the project Customize center.
 *
 * The outer project sidebar (`ProjectSidebar`) keeps just the high-level
 * shape — sessions + files + customize — and this nav owns the long tail
 * of per-project config surfaces (agents, skills, secrets, triggers,
 * channels, settings). Same idea as Vercel's settings page:
 * one umbrella button in the chrome, a focused sub-nav inside.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot,
  KeyRound,
  Settings,
  Slack,
  Sparkles,
  Timer,
  Webhook,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useSlackInstall } from '@/hooks/channels/use-channels-installations';

interface NavItem {
  slug: string;
  label: string;
  icon?: LucideIcon;
  /** Render a single text glyph instead of an icon (used for "/" → Commands). */
  glyph?: string;
  /** Optional one-line hint that surfaces on hover for context. */
  hint?: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { slug: 'agents',     label: 'Agents',     icon: Bot,            hint: 'OpenCode agent personas' },
  { slug: 'skills',     label: 'Skills',     icon: Sparkles,       hint: 'On-demand capabilities' },
  { slug: 'commands',   label: 'Commands',   glyph: '/',           hint: 'Slash commands' },
  { slug: 'secrets',    label: 'Secrets',    icon: KeyRound,       hint: 'Per-project env values' },
  { slug: 'schedules',  label: 'Schedules',  icon: Timer,          hint: 'Cron-driven triggers' },
  { slug: 'webhooks',   label: 'Webhooks',   icon: Webhook,        hint: 'Signed HTTP triggers' },
  { slug: 'channels',   label: 'Channels',   icon: Slack,          hint: 'Slack workspace install' },
];

const FOOTER_ITEMS: readonly NavItem[] = [
  { slug: 'settings', label: 'Settings', icon: Settings, hint: 'Project + access control' },
];

export function CustomizeNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const { data: slackInstall } = useSlackInstall(projectId);
  const channelsConnected = !!slackInstall;

  return (
    <nav
      aria-label="Customize"
      className={cn(
        'flex h-full w-[220px] shrink-0 flex-col border-r border-border/60 bg-background',
        'hidden md:flex',
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          Customize
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.slug}>
              <CustomizeNavLink
                item={item}
                href={`/projects/${projectId}/${item.slug}`}
                active={
                  pathname?.startsWith(`/projects/${projectId}/${item.slug}`) ?? false
                }
                badge={item.slug === 'channels' && channelsConnected ? (
                  <span aria-label="Connected" className="ml-auto inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                ) : null}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-border/40 px-2 py-2">
        <ul className="space-y-0.5">
          {FOOTER_ITEMS.map((item) => (
            <li key={item.slug}>
              <CustomizeNavLink
                item={item}
                href={`/projects/${projectId}/${item.slug}`}
                active={
                  pathname?.startsWith(`/projects/${projectId}/${item.slug}`) ?? false
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function CustomizeNavLink({
  item,
  href,
  active,
  badge,
}: {
  item: NavItem;
  href: string;
  active: boolean;
  badge?: React.ReactNode;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={href}
      title={item.hint}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
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
      <span className="flex-1 truncate">{item.label}</span>
      {badge}
    </Link>
  );
}
