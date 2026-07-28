'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { CTA } from '@/features/marketing/v2/content';
import { TileField } from '@/features/marketing/v2/illustrations';
import { Display, Lead, MAX_W, Pill } from '@/features/marketing/v2/primitives';
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
          'linear-gradient(150deg, color-mix(in oklab, var(--kortix-blue) 4%, var(--background)) 0%, color-mix(in oklab, var(--kortix-blue) 12%, var(--background)) 100%)',
      }}
    >
      <TileField className="absolute inset-y-0 right-[-8%] hidden w-[62%] mask-l-from-55% lg:block" />

      <div className={`${MAX_W} relative py-24 sm:py-32`}>
        <div className="max-w-xl">
          <Display lines={CTA.heading} />
          <Lead className="mt-7">{CTA.description}</Lead>
          <p className="text-muted-foreground mt-6 text-[13px]">{CTA.note}</p>
          <div className="mt-9 flex flex-wrap gap-2">
            <Pill onClick={handleTry}>{CTA.primary}</Pill>
            <Pill variant="soft" onClick={() => openDemo()}>
              {CTA.secondary}
            </Pill>
          </div>
        </div>
      </div>
    </section>
  );
}
