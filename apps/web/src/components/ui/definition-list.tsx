'use client';

/**
 * Kortix <DefinitionList> — key:value pair list.
 *
 * Used for:
 *   • Project About → Details panel
 *   • Issue detail sidebar → Properties
 *   • Trigger / Channel / Tunnel details
 *   • Anywhere you'd otherwise reach for a <table> with two columns
 *
 * Flat, dividerless by default. Set `dividers` to get a 1px rule between
 * rows. Labels are fixed-width so values align.
 *
 * <DefinitionList>
 *   <DefinitionRow label="Path"><code>/workspace/foo</code></DefinitionRow>
 *   <DefinitionRow label="Created">2 days ago</DefinitionRow>
 * </DefinitionList>
 */

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface DefinitionListProps {
  dividers?: boolean;
  className?: string;
  children: ReactNode;
}

export function DefinitionList({
  dividers,
  className,
  children,
}: DefinitionListProps) {
  return (
    <dl
      className={cn(
        dividers && 'divide-y divide-border/60 border-y border-border/60',
        className,
      )}
    >
      {children}
    </dl>
  );
}

export interface DefinitionRowProps {
  label: string;
  /** Width reserved for the label column (default 110px) */
  labelWidth?: number;
  children: ReactNode;
  title?: string;
}

export function DefinitionRow({
  label,
  labelWidth = 110,
  children,
  title,
}: DefinitionRowProps) {
  return (
    <div className="flex items-baseline gap-6 py-2.5">
      <dt
        className="text-[12px] text-muted-foreground/70 shrink-0 font-medium"
        style={{ width: labelWidth }}
      >
        {label}
      </dt>
      <dd
        className="text-[13px] text-foreground/90 min-w-0 flex-1 truncate"
        title={title}
      >
        {children}
      </dd>
    </div>
  );
}
