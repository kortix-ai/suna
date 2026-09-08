'use client';

import { ClockIcon, RobotIcon, SparkleIcon } from '@phosphor-icons/react';
import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * One thing a template brings, as a tile in the contents grid.
 *
 * These are NOT navigable, and that is deliberate: an agent or a trigger inside
 * a template is a declaration in its `kortix.yaml`, not a page of its own. A
 * card that looked clickable and did nothing would be worse than a static one,
 * so there is no hover lift, no chevron, and no cursor change here — the only
 * clickable things on the page are the install action and the source link.
 */
export function TemplateContentCard({
  leading,
  title,
  subtitle,
  trailing,
}: {
  leading: ReactNode;
  title: string;
  subtitle?: string | null;
  trailing?: ReactNode;
}) {
  return (
    <div className="bg-popover flex w-full items-center gap-3 rounded-md border px-4 py-3">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        {subtitle ? (
          <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs leading-relaxed text-pretty">
            {subtitle}
          </p>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}

/** What a content tile can be. Connectors bring their own mark, so they are not here. */
type ContentKind = 'agent' | 'skill' | 'trigger';

const KIND_META: Record<
  ContentKind,
  { Icon: ComponentType<{ className?: string; weight?: 'fill' }>; tint: string; tone: string }
> = {
  // One hue per kind, held apart from the per-template hue in `template-visual`
  // so a purple template does not turn all of its own contents purple.
  agent: { Icon: RobotIcon, tint: 'bg-kortix-purple/15', tone: 'text-kortix-purple' },
  skill: { Icon: SparkleIcon, tint: 'bg-kortix-blue/15', tone: 'text-kortix-blue' },
  trigger: { Icon: ClockIcon, tint: 'bg-kortix-green/15', tone: 'text-kortix-green' },
};

/** The tinted square that leads a content card — the house status-tile shape. */
export function TemplateContentTile({ kind }: { kind: ContentKind }) {
  const { Icon, tint, tone } = KIND_META[kind];
  return (
    <span
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-sm', tint, tone)}
    >
      <Icon weight="fill" className="size-5" />
    </span>
  );
}
