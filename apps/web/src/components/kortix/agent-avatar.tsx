'use client';

/**
 * Agent + user avatar primitives.
 *
 * Agents get a persistent hue (stored in project_agents.color_hue) and an
 * optional icon name (project_agents.icon). We render them as small rounded
 * circles with the icon on a saturation/lightness-fixed HSL background —
 * keeping visual consistency even when the hue is random.
 *
 * Users render with their Supabase avatar_url when available, otherwise
 * a handle-derived colored circle with initials — same shape + size so
 * mixed assignee rows stay aligned.
 */

import { useMemo } from 'react';
import Image from 'next/image';
import {
  Bot, Wrench, Sparkles, Zap, Bug, Shield, Code2, Palette,
  Search, BookOpen, Brain, Cpu, Database, GitBranch, Hammer, Key,
  Rocket, Target, Users, Lightbulb, Compass, Feather, Flame,
  Stethoscope, ClipboardCheck, Activity, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/AuthProvider';
import { getUserHandle } from '@/lib/kortix/user-handle';

// ─── Icon map ────────────────────────────────────────────────────────────────

export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  wrench: Wrench,
  sparkles: Sparkles,
  zap: Zap,
  bug: Bug,
  shield: Shield,
  code: Code2,
  palette: Palette,
  search: Search,
  book: BookOpen,
  brain: Brain,
  cpu: Cpu,
  database: Database,
  git: GitBranch,
  hammer: Hammer,
  key: Key,
  rocket: Rocket,
  target: Target,
  users: Users,
  lightbulb: Lightbulb,
  compass: Compass,
  feather: Feather,
  flame: Flame,
  stethoscope: Stethoscope,
  clipboard: ClipboardCheck,
  activity: Activity,
};

export const AGENT_ICON_KEYS = Object.keys(AGENT_ICONS);

/** Infer a reasonable icon from a slug / name when none is set. */
export function guessAgentIcon(slug: string, name: string): string {
  const n = `${slug} ${name}`.toLowerCase();
  if (/pm|project.?manager|orchestr|lead|manager/.test(n)) return 'target';
  if (/eng|dev|code|build/.test(n)) return 'code';
  if (/qa|test|quality|verify/.test(n)) return 'clipboard';
  if (/bug|fix/.test(n)) return 'bug';
  if (/design|ui|ux|palette/.test(n)) return 'palette';
  if (/research|investigate|explore/.test(n)) return 'search';
  if (/sec|security|shield/.test(n)) return 'shield';
  if (/doc|writer|scribe|book/.test(n)) return 'book';
  if (/data|analytics|sql/.test(n)) return 'database';
  if (/ai|ml|brain/.test(n)) return 'brain';
  if (/spike|zap|fast/.test(n)) return 'zap';
  if (/ship|rocket|release/.test(n)) return 'rocket';
  return 'bot';
}

// ─── Color helpers ───────────────────────────────────────────────────────────

/**
 * Produce the color set for an agent avatar from a hue in [0, 360).
 * Fixed saturation + lightness keep contrast consistent across hues.
 * Values tuned to look good on both light + dark backgrounds.
 */
export function agentColors(hue: number | null | undefined): {
  bg: string; fg: string; ring: string;
} {
  const h = (typeof hue === 'number' && hue >= 0 && hue < 360) ? Math.round(hue) : 210;
  return {
    bg: `hsl(${h} 55% 22%)`,
    fg: `hsl(${h} 90% 80%)`,
    ring: `hsl(${h} 70% 45% / 0.45)`,
  };
}

/** Same treatment for user handles — deterministic hue from the handle. */
export function hashHue(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ─── Agent avatar ────────────────────────────────────────────────────────────

export function AgentAvatar({
  hue, icon, slug, name, size = 'md', className,
}: {
  hue: number | null | undefined;
  icon: string | null | undefined;
  slug: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const { bg, fg, ring } = agentColors(hue);
  const resolved = (icon && AGENT_ICONS[icon]) || AGENT_ICONS[guessAgentIcon(slug, name ?? slug)];
  const Icon = resolved;
  const dims = size === 'xs' ? 'h-4 w-4' : size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-8 w-8' : 'h-6 w-6';
  const iconSize = size === 'xs' ? 'h-2.5 w-2.5' : size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5';
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-full shrink-0', dims, className)}
      style={{ backgroundColor: bg, color: fg, boxShadow: `inset 0 0 0 1px ${ring}` }}
      aria-label={`@${slug}`}
      title={`@${slug}`}
    >
      <Icon className={iconSize} />
    </span>
  );
}

// ─── User avatar ─────────────────────────────────────────────────────────────

export function UserAvatar({
  handle, avatarUrl, size = 'md', className,
}: {
  handle: string;
  avatarUrl?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dims = size === 'xs' ? 'h-4 w-4' : size === 'sm' ? 'h-5 w-5' : size === 'lg' ? 'h-8 w-8' : 'h-6 w-6';
  const pixels = size === 'xs' ? 16 : size === 'sm' ? 20 : size === 'lg' ? 32 : 24;
  const textSize = size === 'xs' ? 'text-[8px]' : size === 'sm' ? 'text-[9px]' : size === 'lg' ? 'text-[12px]' : 'text-[10px]';
  const { bg, fg, ring } = agentColors(hashHue(handle));
  const initial = handle.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-full shrink-0 overflow-hidden', dims, className)}
      style={!avatarUrl ? { backgroundColor: bg, color: fg, boxShadow: `inset 0 0 0 1px ${ring}` } : undefined}
      aria-label={`@${handle}`}
      title={`@${handle}`}
    >
      {avatarUrl ? (
        <Image
          src={avatarUrl}
          alt={handle}
          width={pixels}
          height={pixels}
          className="w-full h-full object-cover"
          unoptimized
        />
      ) : (
        <span className={cn('font-semibold leading-none', textSize)}>{initial}</span>
      )}
    </span>
  );
}

// ─── Convenience hook — current user's avatar props ─────────────────────────

export function useCurrentUserAvatarProps(): { handle: string; avatarUrl: string | null } {
  const { user } = useAuth();
  return useMemo(() => {
    const handle = getUserHandle(user);
    const avatarUrl =
      (user?.user_metadata?.avatar_url as string | undefined) ||
      (user?.user_metadata?.picture as string | undefined) ||
      null;
    return { handle, avatarUrl };
  }, [user]);
}
