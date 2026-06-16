'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { FAQ } from './narrative';

export function Faq() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-10 space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {FAQ.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {FAQ.title}
        </h2>
      </div>

      <Accordion type="single" collapsible className="w-full" defaultValue="q0">
        {FAQ.items.map((item, i) => (
          <AccordionItem key={item.q} value={`q${i}`}>
            <AccordionTrigger className="text-foreground py-5 text-left text-base font-medium hover:no-underline">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground text-[15px] leading-relaxed">
              {item.a}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
