'use client';

import Link from '@/components/site-link';
import { marketingButtonVariants } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { cn } from '@/lib/utils';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import type { ComponentProps, ReactNode } from 'react';

/** The one button shape of the AI OS site: a pill. */
const PILL = 'h-11 rounded-full px-5 text-base';

type PillTone = 'solid' | 'outline';

/** On a dark art pane, wrap the pane in `dark` and the tokens flip; no tone
 *  carries its own color. */
const TONE: Record<PillTone, string> = {
  solid: marketingButtonVariants({ variant: 'default' }),
  outline: marketingButtonVariants({ variant: 'outline' }),
};

export function PillLink({
  tone = 'solid',
  className,
  ...props
}: ComponentProps<typeof Link> & { tone?: PillTone }) {
  return <Link className={cn(TONE[tone], PILL, className)} {...props} />;
}

export function DemoPill({
  tone = 'outline',
  source,
  children,
}: {
  tone?: PillTone;
  source: string;
  children: ReactNode;
}) {
  const openDemo = useRequestDemo();
  return (
    <button type="button" onClick={() => openDemo({ source })} className={cn(TONE[tone], PILL)}>
      {children}
    </button>
  );
}

/** The marketing section container (`layout.md`, Marketing section). */
export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn('mx-auto w-full max-w-7xl px-6 py-24 md:py-30', className)}>
      {children}
    </section>
  );
}

/** A section heading in the display rung: regular weight, tight tracking. */
export function Heading({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h2
      className={cn(
        'text-foreground text-3xl font-normal tracking-tight text-balance sm:text-5xl',
        className,
      )}
    >
      {children}
    </h2>
  );
}

/** The arrow a card carries in its top-right corner. */
export function CardArrow({ className }: { className?: string }) {
  return (
    <ArrowUpRightIcon
      aria-hidden
      className={cn(
        'size-5 shrink-0 transition-transform duration-normal group-hover:translate-x-0.5 group-hover:-translate-y-0.5 motion-reduce:transition-none',
        className,
      )}
    />
  );
}
