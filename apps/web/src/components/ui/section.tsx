'use client';

/**
 * Kortix <Section> — labelled section used inside PageShell.
 *
 * Uppercase micro-label, optional trailing action, generous top-margin
 * between sections. No border box, no card chrome — the label and
 * whitespace do all the visual work.
 *
 * <Section label="About" action={<Button size="sm">Edit</Button>}>
 *   <p>Project description goes here.</p>
 * </Section>
 */

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface SectionProps {
  label?: string;
  action?: ReactNode;
  /** Extra top spacing (defaults to mt-10 between sections) */
  spacing?: 'tight' | 'default' | 'loose';
  className?: string;
  children: ReactNode;
}

const SPACING: Record<NonNullable<SectionProps['spacing']>, string> = {
  tight: 'mt-6',
  default: 'mt-10',
  loose: 'mt-14',
};

export function Section({
  label,
  action,
  spacing = 'default',
  className,
  children,
}: SectionProps) {
  return (
    <section className={cn(SPACING[spacing], 'first:mt-0', className)}>
      {(label || action) && (
        <div className="flex items-center justify-between mb-3">
          {label && (
            <h3 className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/60 font-semibold">
              {label}
            </h3>
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
