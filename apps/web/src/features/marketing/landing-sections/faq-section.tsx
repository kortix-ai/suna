'use client';

import { faq } from '@/features/marketing/faq';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { faqHeading } from './content';

/** One question and its answer, as the FAQ renders them. */
export type FaqItem = { id: string; question: string; answer: string };

/** The home page FAQ: questions from `faq/content.ts` (and its translations). */
export function LandingFaqSection() {
  const { items } = useLocalizedUiCatalog(faq);
  return <FaqSection title={faqHeading.title} titleMuted={faqHeading.titleMuted} items={items} />;
}

/**
 * The FAQ in Buio's shape (faqs/Faq.astro): the two-tone title and a line to
 * the team in the left third, the questions in the right two thirds on
 * hairlines. Each row is a native `details`, so Enter and Space work without
 * script, and its "+" turns a quarter of the way round into "×" when open.
 * The home page and /services both render it.
 */
export function FaqSection({
  title,
  titleMuted,
  items,
}: {
  title: string;
  titleMuted: string;
  items: readonly FaqItem[];
}) {
  return (
    <section id="faq" className="scroll-mt-16 px-8 py-14 lg:px-28 lg:py-20">
      <div className="grid grid-cols-1 gap-y-12 lg:grid-cols-3">
        <div className="lg:pr-8">
          <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
            {title}
            <span className="text-muted-foreground block">{titleMuted}</span>
          </h2>
          <p className="text-muted-foreground mt-4 text-base text-balance">
            Anything else,{' '}
            <Link
              href="/contact"
              className="text-foreground hover:text-muted-foreground outline-ring duration-normal rounded-sm underline-offset-4 transition-colors ease-out hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              write to the team
            </Link>
            .
          </p>
        </div>

        {/* The answers start collapsed; this states every one for search and answer engines. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonForHtml({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: items.map((item) => ({
                '@type': 'Question',
                name: item.question,
                acceptedAnswer: { '@type': 'Answer', text: item.answer },
              })),
            }),
          }}
        />

        <div className="divide-border flex flex-col divide-y lg:col-span-2">
          {items.map((item) => (
            <details
              key={item.id}
              id={item.id}
              className="group scroll-mt-16 py-6 first:pt-0 last:pb-0"
            >
              <summary className="text-foreground outline-ring flex w-full cursor-pointer list-none items-start justify-between rounded-sm text-left text-lg select-none focus-visible:outline-2 focus-visible:outline-offset-4 [&::-webkit-details-marker]:hidden">
                <span className="pr-8 text-pretty">{item.question}</span>
                <PlusIcon
                  aria-hidden
                  className="group-open:text-muted-foreground duration-normal mt-1.5 size-4 shrink-0 transition-[rotate,color] ease-out group-open:-rotate-45 motion-reduce:transition-none"
                />
              </summary>
              <p className="text-muted-foreground max-w-2xl py-4 text-base text-pretty">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
