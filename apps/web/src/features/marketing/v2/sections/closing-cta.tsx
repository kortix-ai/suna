'use client';

import { Button } from '@/components/ui/marketing/button';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { CTA } from '@/features/marketing/v2/content';
import { Heading, Lead } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

export function ClosingCta() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleTry = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section className="bg-background border-border relative isolate overflow-hidden border-t">
      <TileField />
      <div className="relative mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <div className="max-w-lg">
          <Heading lines={CTA.heading} />
          <Lead className="mt-6">{CTA.description}</Lead>
          <p className="text-muted-foreground mt-6 text-xs tracking-wider">{CTA.note}</p>
          <div className="mt-8 flex flex-wrap gap-2">
            <Button size="lg" onClick={handleTry}>
              {CTA.primary}
              <HiArrowRight className="size-4" />
            </Button>
            <Button size="lg" variant="secondary" onClick={() => openDemo()}>
              {CTA.secondary}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Isometric tile field, echoing the stack section's slabs. */
function TileField() {
  return (
    <div
      aria-hidden
      data-a11y-decorative
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 overflow-hidden mask-l-from-60% lg:block"
      style={{ perspective: '1200px' }}
    >
      <div
        className="absolute top-1/2 left-1/2 grid grid-cols-5 gap-2"
        style={{ transform: 'translate(-50%,-50%) rotateX(58deg) rotateZ(-45deg)' }}
      >
        {Array.from({ length: 25 }).map((_, i) => (
          <div
            key={i}
            className={
              i % 7 === 0 || i % 11 === 3
                ? 'border-kortix-blue/35 bg-kortix-blue/15 size-20 rounded-sm border'
                : 'border-border bg-muted/50 size-20 rounded-sm border'
            }
          />
        ))}
      </div>
    </div>
  );
}
