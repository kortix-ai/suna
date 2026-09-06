'use client';

import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { SandboxTemplate } from '@kortix/sdk';
import {
  FileCodeIcon,
  type Icon,
  PackageIcon,
  RobotIcon,
  ShippingContainerIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * ONE menu for choosing a sandbox template, wherever the choice appears
 * (Marko, 2026-09-03: "1 common shared component we will always use"):
 *
 *  - the composer / session-overrides "Sandbox" row (`SandboxPicker`), where
 *    the inherit entry is "Agent environment";
 *  - the agent editor's Workspace page, where it is "Project default".
 *
 * The first entry is deliberately not a template: picking it CLEARS the
 * override instead of pinning today's default, so a later change to the
 * agent or project default still applies. Its description names what that
 * resolves to right now, so "default" is never a mystery word.
 */
export function SandboxTemplateMenu({
  items,
  selectedSlug,
  resolvedSlug,
  inherit,
  onSelect,
  trigger,
  align = 'start',
}: {
  items: SandboxTemplate[];
  /** The pinned slug, or null for "inherit". */
  selectedSlug: string | null;
  /** What "inherit" resolves to right now — named in the inherit entry. */
  resolvedSlug: string | null;
  inherit: { label: string; description: string };
  onSelect: (slug: string | null) => void;
  trigger: ReactNode;
  align?: 'start' | 'end';
}) {
  const resolved = resolvedSlug ? items.find((t) => t.slug === resolvedSlug) : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-80">
        <DropdownMenuLabel>Sandbox template</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="flex items-start gap-2" onSelect={() => onSelect(null)}>
          <RobotIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{inherit.label}</span>
              {selectedSlug === null && (
                <Badge variant="outline" size="xs">
                  selected
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground text-xs">{inherit.description}</div>
            {resolved ? (
              <div className="text-muted-foreground mt-0.5 text-xs">
                Currently <span className="text-foreground">{resolved.name}</span>
              </div>
            ) : null}
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {items.map((tpl) => {
          const d = describeSandboxTemplate(tpl);
          return (
            <DropdownMenuItem
              key={tpl.template_id ?? `tpl-${tpl.slug}`}
              className="flex items-start gap-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <d.Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === selectedSlug && (
                    <Badge variant="outline" size="xs">
                      selected
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">{d.subtitle}</div>
                <div className={cn('mt-0.5 text-xs', d.stateText)}>{d.stateLabel}</div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Icon, one-line source, and build state for a template — shared by every
 *  row and every trigger that shows one. */
export function describeSandboxTemplate(tpl: SandboxTemplate): {
  Icon: Icon;
  subtitle: string;
  stateLabel: string;
  /** Text tone for the state line. */
  stateText: string;
  /** Background tone for a status dot. */
  stateDot: string;
} {
  const Icon = tpl.is_default ? ShippingContainerIcon : tpl.has_image ? PackageIcon : FileCodeIcon;
  const subtitle = tpl.is_default
    ? 'Platform default · clones workspace at boot'
    : tpl.has_image
      ? `Image: ${tpl.image}`
      : `Dockerfile: ${tpl.dockerfile_path}`;
  const building = ['pulling', 'building'].includes(tpl.daytona_state);
  const tone =
    tpl.daytona_state === 'active'
      ? 'green'
      : building
        ? 'blue'
        : tpl.daytona_state === 'missing'
          ? 'muted'
          : 'red';
  return {
    Icon,
    subtitle,
    stateLabel:
      tpl.daytona_state === 'active'
        ? 'Ready'
        : building
          ? 'Building — session will wait'
          : tpl.daytona_state === 'missing'
            ? 'Not built — first session will build it'
            : tpl.daytona_state.replace('_', ' '),
    stateText: {
      green: 'text-kortix-green',
      blue: 'text-kortix-blue',
      muted: 'text-muted-foreground',
      red: 'text-destructive',
    }[tone],
    stateDot: {
      green: 'bg-kortix-green',
      blue: 'bg-kortix-blue',
      muted: 'bg-muted-foreground/40',
      red: 'bg-destructive',
    }[tone],
  };
}
