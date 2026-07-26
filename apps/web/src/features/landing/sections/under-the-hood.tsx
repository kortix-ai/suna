'use client';

import { Button } from '@/components/ui/marketing/button';
import { underTheHood } from '@/features/landing/content';
import { SectionHeader } from '@/features/landing/section-header';
import { HiArrowRight } from 'react-icons/hi2';

/**
 * The deeper technical strip near the bottom of the page.
 *
 * Everything above this point is deliberately simple; this is where the page
 * earns credibility with the people who want to know how it actually works,
 * then hands off to /technology for the full argument. Rendered as a spec table
 * rather than more marketing cards — the density is the point.
 */
export function LandingUnderTheHood() {
  return (
    <section className="border-border bg-muted/25 border-t px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <SectionHeader
          eyebrow={underTheHood.eyebrow}
          title={underTheHood.title}
          intro={underTheHood.body}
        />

        {/* The manifest — the most concrete proof that the company is text. */}
        <figure className="border-border bg-card mt-14 overflow-hidden rounded-lg border">
          <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
            <span className="flex gap-1.5" aria-hidden="true" data-a11y-decorative>
              <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
              <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
              <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
            </span>
            <span className="text-muted-foreground ml-1 font-mono text-xs">
              {underTheHood.manifest.filename}
            </span>
          </div>
          <pre className="overflow-x-auto px-5 py-5 font-mono text-xs leading-relaxed sm:text-sm">
            <code className="text-foreground/85">{underTheHood.manifest.code}</code>
          </pre>
          <figcaption className="border-border text-muted-foreground border-t px-5 py-3 text-sm">
            {underTheHood.manifest.caption}
          </figcaption>
        </figure>

        <dl className="border-border mt-14 border-t">
          {underTheHood.specs.map((spec) => (
            <div
              key={spec.label}
              className="border-border grid gap-x-8 gap-y-2 border-b py-6 md:grid-cols-[13rem_1fr]"
            >
              <dt className="text-muted-foreground text-sm">{spec.label}</dt>
              <dd>
                <p className="text-foreground font-mono text-sm">{spec.value}</p>
                <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-relaxed">
                  {spec.detail}
                </p>
              </dd>
            </div>
          ))}
        </dl>

        <Button size="lg" variant="secondary" asChild className="mt-10 w-fit">
          {/* TODO(landing): re-point at /technology once that page exists. */}
          <a href="/developers">
            {underTheHood.cta}
            <HiArrowRight className="size-4" />
          </a>
        </Button>
      </div>
    </section>
  );
}
