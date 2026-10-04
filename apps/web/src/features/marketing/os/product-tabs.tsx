'use client';

import Link from '@/components/site-link';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import { useState } from 'react';
import { useOsContent } from './use-os-content';
import { CardArrow, Heading, Section } from './primitives';

/**
 * The product tour. Pill tabs drive one large card: the copy on the left, the
 * real screen on the right. The screens are dark captures, so the card is a
 * dark pane in both themes and the screen never reads as a bright panel.
 */
export function ProductTabs() {
  const { productTabs } = useOsContent();
  const [active, setActive] = useState<string>(productTabs.tabs[0].id);
  const tab = productTabs.tabs.find((t) => t.id === active) ?? productTabs.tabs[0];

  return (
    <Section>
      <Heading className="mx-auto max-w-3xl text-center">{productTabs.title}</Heading>

      <div role="tablist" className="bg-muted mx-auto mt-10 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full p-1 [scrollbar-width:none]">
        {productTabs.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
            className={cn(
              'h-9 shrink-0 rounded-full px-4 text-sm transition-colors',
              t.id === active
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="dark bg-background border-border mt-8 grid overflow-hidden rounded-xl border lg:grid-cols-[2fr_3fr]">
        <div key={tab.id} className="flex flex-col justify-between gap-10 p-8 lg:p-12 motion-safe:animate-[kx-fade_300ms_ease-out_both]">
          <div className="space-y-4">
            <h3 className="text-foreground text-3xl font-normal tracking-tight text-balance sm:text-4xl">{tab.title}</h3>
            <p className="text-muted-foreground text-base leading-relaxed text-pretty">{tab.body}</p>
          </div>
          <Link href={tab.href} className="group text-foreground flex w-fit items-center gap-2 text-sm">
            <span className="underline underline-offset-4">{productTabs.learnMore.label}</span>
            <CardArrow className="size-4" />
          </Link>
        </div>
        {/* The screen is cropped at its top-left, at about 1.6x, so the
            interface reads at its real size instead of as a thumbnail. */}
        <div className="relative min-h-80 overflow-hidden lg:min-h-[32rem]">
          <div className="border-border absolute top-10 left-10 w-[160%] overflow-hidden rounded-tl-lg border-t border-l">
            <Image
              key={tab.image}
              src={tab.image}
              alt={tab.title}
              width={2880}
              height={1800}
              sizes="(min-width: 1024px) 1200px, 160vw"
              className="h-auto w-full motion-safe:animate-[kx-fade_300ms_ease-out_both]"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}
