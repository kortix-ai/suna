'use client';

import { CTA } from '@/features/marketing/v2/content';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { Heading } from '@/features/marketing/v2/primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';

export function ClosingCta() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleTry = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section
      className="relative isolate overflow-hidden"
      style={{
        background:
          'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 5%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 14%, var(--background)) 100%)',
      }}
    >
      <TileField />
      <div className="relative mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <div className="max-w-lg">
          <Heading lines={CTA.heading} />
          <p className="text-muted-foreground mt-6 text-[1.0625rem] leading-relaxed">
            {CTA.description}
          </p>
          <div className="mt-9 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleTry}
              className="bg-foreground text-background hover:bg-foreground/90 flex h-11 cursor-pointer items-center rounded-full px-6 text-sm font-medium transition-colors"
            >
              {CTA.primary}
            </button>
            <button
              type="button"
              onClick={() => openDemo()}
              className="bg-foreground/[0.06] text-foreground hover:bg-foreground/10 flex h-11 cursor-pointer items-center rounded-full px-6 text-sm font-medium transition-colors"
            >
              {CTA.secondary}
            </button>
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
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 overflow-hidden lg:block"
      style={{ perspective: '1200px' }}
    >
      <div
        className="absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-5 gap-2"
        style={{ transform: 'translate(-50%,-50%) rotateX(58deg) rotateZ(-45deg)' }}
      >
        {Array.from({ length: 25 }).map((_, i) => (
          <div
            key={i}
            className="size-20 rounded"
            style={{
              background:
                i % 7 === 0 || i % 11 === 3
                  ? 'color-mix(in oklab, var(--kortix-blue) 30%, transparent)'
                  : 'color-mix(in oklab, var(--kortix-blue) 8%, transparent)',
              border: '1px solid color-mix(in oklab, var(--kortix-blue) 18%, transparent)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
