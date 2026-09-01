'use client';

import {
  RobotIcon as Bot,
  ShippingContainerIcon as Container,
  FileCodeIcon as FileCode,
  PackageIcon as Package,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';

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

/**
 * The sandbox-template override for the next session, as a dropdown on the
 * composer's toolbar. The default entry ("Agent environment") is deliberately
 * first and deliberately not a template: picking it clears the override rather
 * than pinning today's default, so a later change to the agent or project
 * default still applies.
 */
export function SandboxPicker({
  items,
  activeSlug,
  selectedSlug,
  onSelect,
}: {
  items: SandboxTemplate[];
  activeSlug: string;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const active = items.find((t) => t.slug === activeSlug) ?? items[0] ?? null;
  if (!active) return null;
  const ActiveIcon = active.is_default ? Container : active.has_image ? Package : FileCode;
  const activeStateTone =
    active.daytona_state === 'active'
      ? 'bg-kortix-green'
      : ['pulling', 'building'].includes(active.daytona_state)
        ? 'bg-kortix-blue'
        : active.daytona_state === 'missing'
          ? 'bg-muted-foreground/40'
          : 'bg-destructive';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tI18nHardcoded.raw(
            'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxAttrAria4acf4ecd',
          )}
          className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-fast"
        >
          <ActiveIcon className="size-3.5 shrink-0" />
          <span className="max-w-[7rem] truncate">
            {selectedSlug ? active.name : 'Agent environment'}
          </span>
          <span className={cn('size-1.5 shrink-0 rounded-full', activeStateTone)} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>
          {tI18nHardcoded.raw('autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSandboxe9c5fbaa')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="flex items-start gap-2" onSelect={() => onSelect(null)}>
          <Bot className="text-muted-foreground mt-0.5 size-4" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Agent environment</span>
              {selectedSlug === null && (
                <Badge variant="outline" size="xs">
                  selected
                </Badge>
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              Uses the selected agent, project, or platform default.
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {items.map((tpl) => {
          const Icon = tpl.is_default ? Container : tpl.has_image ? Package : FileCode;
          const subtitle = tpl.is_default
            ? 'Platform default · clones workspace at boot'
            : tpl.has_image
              ? `Image: ${tpl.image}`
              : `Dockerfile: ${tpl.dockerfile_path}`;
          const stateTone =
            tpl.daytona_state === 'active'
              ? 'text-kortix-green'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'text-kortix-blue'
                : tpl.daytona_state === 'missing'
                  ? 'text-muted-foreground'
                  : 'text-destructive';
          const stateLabel =
            tpl.daytona_state === 'active'
              ? 'Ready'
              : ['pulling', 'building'].includes(tpl.daytona_state)
                ? 'Building — session will wait'
                : tpl.daytona_state === 'missing'
                  ? 'Not built — first session will build it'
                  : tpl.daytona_state.replace('_', ' ');
          return (
            <DropdownMenuItem
              key={tpl.template_id ?? `tpl-${tpl.slug}`}
              className="flex items-start gap-2"
              onSelect={() => onSelect(tpl.slug)}
            >
              <Icon className="text-muted-foreground mt-0.5 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tpl.name}</span>
                  {tpl.slug === selectedSlug && (
                    <Badge variant="outline" size="xs">
                      selected
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
                <div className={cn('mt-0.5 text-xs capitalize', stateTone)}>{stateLabel}</div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
