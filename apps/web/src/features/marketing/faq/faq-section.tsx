'use client';

import { Reveal } from '@/components/home/reveal';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import SectionHeader from '@/features/marketing/component/section-header';
import type { ReactNode } from 'react';
import { faq, type FaqItem } from './content';

type FaqSectionProps = {
  eyebrow?: string;
  title?: string;
  items?: readonly FaqItem[];
};

export function FaqSection({
  eyebrow = faq.eyebrow,
  title = faq.title,
  items = faq.items,
}: FaqSectionProps): ReactNode {
  return (
    <section
      id="faq"
      className="mx-auto grid w-full max-w-7xl grid-cols-1 px-6 py-24 md:py-30 lg:grid-cols-[35%_minmax(0,1fr)] lg:gap-x-12"
    >
      <div className="w-full min-w-0">
        <SectionHeader eyebrow={eyebrow} title={title} />
      </div>

      <Reveal delay={0.06} className="mt-10 w-full min-w-0 lg:mt-0">
        <Accordion type="single" collapsible className="flex w-full flex-col gap-1 border-0">
          {items.map((item) => (
            <AccordionItem
              key={item.id}
              value={item.id}
              id={item.id}
              className="hover:bg-card data-[state=open]:bg-card rounded-lg border-0 transition-colors"
            >
              <AccordionTrigger className="rounded-lg px-5 py-5 text-left hover:no-underline sm:px-8">
                <span className="text-foreground min-w-0 text-base leading-snug font-medium tracking-tight text-balance">
                  {item.question}
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-5 pb-6 sm:px-8">
                <p className="text-muted-foreground max-w-[36rem] min-w-0 text-base leading-[1.7] text-pretty">
                  {item.answer}
                </p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  );
}
