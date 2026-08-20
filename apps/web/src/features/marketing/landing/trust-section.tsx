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
    <li className="border-border flex w-full min-w-0 flex-col items-center justify-start gap-2 border-b px-2 pb-6 text-center last:border-b-0 last:pb-0 sm:border-b-0 sm:border-l sm:px-4 sm:pb-0 sm:first:border-l-0 lg:px-6">
      <div className="aspect-square w-full max-w-36 sm:max-w-32 lg:max-w-40 [&_svg]:size-full [&_svg]:scale-90">
        {children}
      </div>
      {label ? (
        <span className="text-muted-foreground max-w-full font-mono text-[10px] leading-none tracking-wide uppercase">
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
          <div className="relative grid gap-8 px-5 py-10 sm:gap-10 sm:px-8 sm:py-12 lg:grid-cols-12 lg:gap-14 lg:px-10">
            <div className="flex min-w-0 flex-col gap-8 sm:gap-16 lg:col-span-7 lg:gap-28">
              <div className="flex min-w-0 flex-col gap-4 select-none">
                <p className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none">
                  {trust.eyebrow}
                </p>

                <h2 className="text-foreground max-w-full font-sans text-2xl leading-snug font-medium text-pretty sm:max-w-125 sm:text-3xl sm:leading-tight sm:text-balance md:text-4xl">
                  Giving agents real access is the easy part. <br className="hidden sm:block" />
                  Trusting them with it is the work.
                </h2>
                {/* <p className="mt-5 max-w-md text-base leading-relaxed text-white/55">{trust.sub}</p> */}
              </div>

              <Button size="lg" variant="secondary" className="group/arrow-right w-fit" asChild>
                <Link href={trust.ctaHref}>
                  {trust.ctaLabel}
                  <ArrowRightIcon />
                </Link>
              </Button>
            </div>

            <div className="w-full min-w-0 lg:col-span-5 lg:justify-self-end">
              <ul className="grid w-full grid-cols-3 items-start">
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
