'use client';

import { faq } from '@/features/landing/content';
import { SectionHeader } from '@/features/landing/section-header';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

/** Plain question list — the Cowork FAQ accordion. */
export function LandingFaq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="border-border border-t px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-3xl">
        <SectionHeader eyebrow={faq.eyebrow} title={faq.title} />

        <div className="mt-10">
          {faq.items.map((item, i) => {
            const isOpen = openIndex === i;
            return (
              <div key={item.q} className="border-border border-b first:border-t">
                <h3>
                  <button
                    type="button"
                    onClick={() => setOpenIndex(isOpen ? null : i)}
                    aria-expanded={isOpen}
                    className="text-foreground flex w-full cursor-pointer items-start justify-between gap-6 py-5 text-left text-base font-medium"
                  >
                    {item.q}
                    <PlusIcon
                      className={cn(
                        'text-muted-foreground mt-1 size-4 shrink-0 transition-transform duration-200',
                        isOpen && 'rotate-45',
                      )}
                    />
                  </button>
                </h3>

                <AnimatePresence initial={false}>
                  {isOpen ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
                      className="overflow-hidden"
                    >
                      <p className="text-muted-foreground max-w-2xl pb-6 text-sm leading-relaxed">
                        {item.a}
                      </p>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
