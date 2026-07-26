'use client';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/marketing/button';
import { ShaderSafe } from '@/components/ui/shader-safe';
import { security } from '@/features/landing/content';
import { SectionHeader } from '@/features/landing/section-header';
import { Heatmap } from '@paper-design/shaders-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * Enterprise & security — carried over from the current marketing homepage.
 *
 * Kept deliberately close to the original: the shader-lit brandmark panel on
 * the left, one-at-a-time accordion on the right. It is the strongest existing
 * section and the page would lose credibility without it.
 */
export function LandingSecurity() {
  const [activeId, setActiveId] = useState<string>(security.items[0].id);

  return (
    <section className="border-border border-t px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeader
          eyebrow={security.eyebrow}
          title={security.title}
          intro={security.description}
          className="mb-14"
        />

        <div className="border-border bg-card grid min-h-[390px] w-full overflow-hidden rounded-sm border lg:grid-cols-12">
          <div className="bg-foreground relative hidden h-full w-full overflow-hidden rounded-sm border-b lg:col-span-4 lg:block lg:border-r lg:border-b-0">
            <div className="relative flex h-full w-full items-center justify-center lg:scale-90">
              <ShaderSafe>
                <Heatmap
                  speed={1}
                  contour={0.5}
                  angle={0}
                  noise={0}
                  innerGlow={0.5}
                  outerGlow={0.05}
                  scale={0.65}
                  image="/shaders/heatmap-mark.svg"
                  frame={407072.499999992}
                  colors={['var(--kortix-orange)', '#fafafa', '#242424']}
                  colorBack="#ffffff00"
                  className="shrink-0"
                  style={{ height: '182px', width: '220px' }}
                />
              </ShaderSafe>
            </div>
          </div>

          <div className="flex h-full min-h-0 flex-1 flex-col space-y-6 lg:col-span-8">
            <Accordion
              type="single"
              collapsible
              className="w-full"
              value={activeId}
              onValueChange={setActiveId}
            >
              {security.items.map((item) => (
                <AccordionItem key={item.id} value={item.id} className="px-4 py-2 lg:last:border-b">
                  <AccordionTrigger className="group/trigger [&[data-state=open]>svg]:text-primary text-foreground px-4 py-5 text-lg font-medium hover:no-underline lg:text-xl">
                    {item.title}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground pl-4 text-base leading-relaxed">
                    {item.body}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>

            <div className="mt-auto px-4 pb-7">
              <Button size="sm" className="w-fit" asChild>
                <Link href="/enterprise">{security.learnMore}</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
