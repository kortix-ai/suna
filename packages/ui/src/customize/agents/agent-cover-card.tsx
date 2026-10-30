'use client';

import type { ReactNode } from 'react';

import { UiLink as Link } from '../../providers/ui-provider';
import { AgentMarkGlyph, agentMarkVars } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';

/**
 * An Agents-page card led by the agent's pixel-mark cover. The cover gives
 * every agent a face that is the same wherever the agent appears, so a long
 * list is scanned by shape and tone before names are read.
 */
export function AgentCoverCard({
  slug,
  href,
  onIntent,
  title,
  description,
  badges,
  meta,
  coverLabel,
}: {
  slug: string;
  href: string;
  onIntent?: () => void;
  title: ReactNode;
  description?: string | null;
  badges?: ReactNode;
  meta?: ReactNode;
  /** A short pill on the cover's top-left corner — "Default". */
  coverLabel?: string;
}) {
  return (
    <Link
      href={href}
      prefetch
      onPointerEnter={onIntent}
      onFocus={onIntent}
      style={agentMarkVars(slug)}
      className={cn(
        'group bg-card border-border/60 flex flex-col overflow-hidden rounded-md border text-left',
        'hover:border-border transition-[border-color] duration-(--duration-normal) ease-out',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
      )}
    >
      <span className="relative flex h-31 items-center justify-center bg-(--mark-tile)">
        <AgentMarkGlyph slug={slug} size={56} />
        {coverLabel ? (
          <span className="bg-background/20 absolute top-2.5 left-2.5 rounded-sm px-2 py-0.5 text-xs font-medium text-(--mark-ink) backdrop-blur-sm">
            {coverLabel}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 px-3.5 pt-3 pb-3.5">
        <span className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {description ? (
          <span className="text-muted-foreground line-clamp-2 text-xs text-pretty">
            {description}
          </span>
        ) : null}
        {meta ? (
          <span className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1.5 text-xs">
            {meta}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
