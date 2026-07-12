'use client';

/**
 * Small reusable UI primitives shared across the agent editor's sibling files
 * (permission-editor.tsx, grant-mode-field.tsx, the per-layer field sections,
 * and agent-editor.tsx itself).
 */

import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { Bot } from 'lucide-react';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  allowUnset,
}: {
  options: readonly { value: T; label: string }[];
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  /** When set, clicking the active option again clears it (back to inherit). */
  allowUnset?: boolean;
}) {
  return (
    <div className="border-border/70 inline-flex overflow-hidden rounded-md border">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(allowUnset && active ? undefined : o.value)}
            className={cn(
              'px-2.5 py-1.5 text-xs capitalize transition-[color,background-color,transform] active:scale-[0.96]',
              active
                ? 'bg-secondary text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function FieldRow({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <Label className="text-xs">{label}</Label>
        {hint ? <span className="text-muted-foreground/60 text-[11px]">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function SectionHeader({ icon: Icon, title }: { icon: typeof Bot; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-foreground/80 text-xs font-medium tracking-wide uppercase">{title}</span>
    </div>
  );
}

/**
 * The top-level layer divider — makes the Kortix/Runtime split visually
 * unmistakable (spec §2.2 structural refactor: "Kortix concerns and Runtime
 * concerns are 100% distinct"). Each layer's fields sit in their own labeled
 * group below this header.
 */
export function LayerHeader({
  label,
  tone,
  description,
  icon: Icon,
}: {
  label: string;
  tone: 'kortix' | 'outline';
  description: string;
  icon: typeof Bot;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border/60 pb-2.5">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-sm',
          tone === 'kortix' ? 'bg-kortix-base/20' : 'bg-muted',
        )}
      >
        <Icon className={cn('size-3.5', tone === 'kortix' ? 'text-foreground' : 'text-muted-foreground')} />
      </span>
      <Badge variant={tone} size="sm" className="shrink-0 tracking-wide uppercase">
        {label}
      </Badge>
      <p className="text-muted-foreground/70 min-w-0 text-[11px] leading-relaxed text-pretty">
        {description}
      </p>
    </div>
  );
}
