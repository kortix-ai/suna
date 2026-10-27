import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { BriefcaseIcon, CellTowerIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { caseStudies } from './content';

const ICONS = { telecom: CellTowerIcon, search: BriefcaseIcon } as const;

function Facts({ items }: { items: readonly string[] }): ReactNode {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {items.map((item) => (
        <li key={item} className="text-foreground flex items-start gap-2">
          <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * Case studies as plain cards: one featured (SciencePal, with its logo), then
 * the anonymised ones. Nothing here links anywhere, on purpose. Copy and the
 * naming rules: `./content.ts`.
 */
export function CaseStudies({ id = 'case-studies' }: { id?: string }) {
  const { featured, items } = caseStudies;
  return (
    <section id={id} className="scroll-mt-16 py-20 lg:py-28">
      <Heading title={caseStudies.title} titleMuted={caseStudies.titleMuted} />
      <Band className="mt-12">
        <article className="grid grid-cols-1 lg:grid-cols-2">
          <div className="bg-muted flex min-h-64 flex-col items-center justify-center gap-5 p-10 text-center">
            <Image
              src={featured.logo.src}
              alt={featured.logo.alt}
              width={featured.logo.width}
              height={featured.logo.height}
              className="h-auto w-56 lg:w-72"
            />
            <p className="text-muted-foreground max-w-xs text-sm text-balance">{featured.org}</p>
          </div>
          <div className="flex flex-col gap-5 border-t p-6 lg:border-t-0 lg:border-l lg:p-11">
            <p className="text-muted-foreground text-sm">{featured.category}</p>
            <h3 className="text-foreground text-xl font-medium tracking-tight text-balance lg:text-2xl">{featured.title}</h3>
            <p className="text-muted-foreground text-base text-pretty">{featured.body}</p>
            <Facts items={featured.facts} />
          </div>
        </article>
        <ul className="bg-border grid grid-cols-1 gap-px border-t lg:grid-cols-2">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <li key={item.id} className="bg-background flex flex-col gap-5 p-6 lg:p-11">
                <div className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Icon className="text-foreground size-5" aria-hidden />
                  {item.category}
                </div>
                <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">{item.title}</h3>
                <p className="text-muted-foreground text-base text-pretty">{item.body}</p>
                <Facts items={item.facts} />
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}
