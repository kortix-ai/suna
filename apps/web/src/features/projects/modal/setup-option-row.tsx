'use client';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function SetupOptionRow({
  icon,
  title,
  description,
  badge,
  selected,
  disabled,
  onToggle,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex min-h-10 cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors',
        selected ? 'bg-primary/[0.05]' : 'hover:bg-foreground/[0.03]',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{title}</span>
          {badge ? (
            <Badge variant="new" size="sm" className="shrink-0">
              {badge}
            </Badge>
          ) : null}
          {selected ? (
            <Badge variant="outline" size="sm" className="shrink-0">
              Included
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-0.5 line-clamp-2 text-pretty text-xs leading-relaxed">
          {description}
        </p>
      </div>
      <Checkbox
        checked={selected}
        onCheckedChange={(value) => onToggle(value === true)}
        disabled={disabled}
        aria-label={title}
        className="mt-0.5 shrink-0"
      />
    </label>
  );
}
