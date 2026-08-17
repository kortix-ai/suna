'use client';

import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { ArrowRightIcon } from '@/features/icon/arrow-right';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import GDPR from '../trust/gdpr';
import Soc2Type1 from '../trust/soc-2-type-1';
import Soc2Type2 from '../trust/soc-2-type-2';
import { trust } from './content';

function TrustSeal({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <li className="flex flex-col items-center justify-start space-y-2 px-4 text-center lg:px-8">
      {children}
      {label ? (
        <span className="text-muted-foreground font-mono text-[10px] leading-none tracking-wide uppercase">
          {label}
        </span>
      ) : null}
    </li>
  );
}

function TrustColumn({
  title,
  body,
  className,
}: {
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <div className={cn('px-6 py-8 sm:px-8 sm:py-10', className)}>
      <span
        aria-hidden
        className="bg-muted-foreground text-muted-foreground-foreground flex size-5 items-center justify-center rounded-sm"
      >
        <CheckIcon className="size-3" weight="bold" />
      </span>
      <h3 className="text-foreground mt-4 text-base font-medium tracking-tight">{title}</h3>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{body}</p>
    </div>
  );
}

/**
 * The closing section: what makes the platform trustworthy, and exactly where
 * we stand on certification. Tembo runs the same shape (one dark card, badges,
 * three pillars); the honest half is ours — the badge row states plainly that
 * nothing is certified yet.
 */
export function TrustSection(): ReactNode {
  return (
    <section id="trust" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
      <Reveal>
        <div className="border-border relative isolate overflow-hidden rounded-xl border">
          {/* upper: headline + CTA on the left, badge shields on the right */}
          <div className="relative grid gap-10 px-6 py-12 sm:px-8 lg:grid-cols-12 lg:gap-14 lg:px-10">
            <div className="space-y-28 lg:col-span-7">
              <div className="flex flex-col gap-4 select-none">
                <p className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none">
                  {trust.eyebrow}
                </p>

                <h2 className="text-foreground max-w-125 font-sans text-3xl font-medium text-balance sm:text-4xl">
                  Giving agents real access is the easy part. <br />
                  Trusting them with it is the work.
                </h2>
                {/* <p className="mt-5 max-w-md text-base leading-relaxed text-white/55">{trust.sub}</p> */}
              </div>

              <Button size="lg" variant="ghost" className="group/arrow-right" asChild>
                <Link href={trust.ctaHref}>
                  {trust.ctaLabel}
                  <ArrowRightIcon />
                </Link>
              </Button>
            </div>

            <div className="lg:col-span-5 lg:justify-self-end">
              <ul className="divide-border flex items-stretch divide-x">
                <TrustSeal label="In progress">
                  <Soc2Type1 />
                </TrustSeal>
                <TrustSeal label="In progress">
                  <Soc2Type2 />
                </TrustSeal>
                <TrustSeal>
                  <GDPR />
                </TrustSeal>
              </ul>
            </div>
          </div>

          {/* lower: three pillars, thin rules between them */}
          {/* <div className="relative grid border-t border-white/10 sm:grid-cols-3">
            {trust.columns.map((column, i) => (
              <TrustColumn
                key={column.id}
                title={column.title}
                body={column.body}
                className={cn(i > 0 && 'border-t border-white/10 sm:border-t-0 sm:border-l')}
              />
            ))}
          </div> */}
        </div>
      </Reveal>
    </section>
  );
}
