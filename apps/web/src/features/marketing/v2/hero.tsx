'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { HERO } from '@/features/marketing/v2/content';
import { MAX_W, Pill } from '@/features/marketing/v2/primitives';
import { Screenshot } from '@/features/marketing/v2/real-visual';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Check } from 'lucide-react';
import { useCallback } from 'react';

export function Hero() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleGetStarted = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section className="relative isolate">
      {/* the field — an always-blue surface, so its type is white in both themes */}
      <div
        aria-hidden
        data-a11y-decorative
        className="pointer-events-none absolute inset-0 -z-10"
        style={
          {
            // every stop is the Kortix accent itself, only shaded — never mixed
            // with a foreign navy, which is what dulls the hue.
            '--field-1': 'color-mix(in oklab, var(--kortix-blue) 88%, black)',
            '--field-2': 'var(--kortix-blue)',
            '--field-3': 'color-mix(in oklab, var(--kortix-blue) 32%, var(--background))',
            background:
              'linear-gradient(172deg, var(--field-1) 0%, var(--field-2) 44%, var(--field-3) 78%, var(--background) 100%)',
          } as React.CSSProperties
        }
      >
        <div
          className="absolute inset-0 opacity-90"
          style={{
            background:
              'radial-gradient(60% 45% at 88% 6%, rgba(255,255,255,0.26) 0%, transparent 62%), radial-gradient(45% 38% at 4% 74%, rgba(255,255,255,0.20) 0%, transparent 66%)',
          }}
        />
      </div>

      <div className={`${MAX_W} pt-32 sm:pt-40`}>
        <p className="mb-5 text-[13px] tracking-wider text-white/70 uppercase">{HERO.eyebrow}</p>
        <h1 className="max-w-3xl text-[2.75rem] leading-[1.03] font-medium tracking-[-0.025em] text-white sm:text-[3.5rem] lg:text-[4.25rem]">
          {HERO.headline.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>

        <div className="mt-12 flex flex-col gap-6 sm:mt-14 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-lg text-[1.0625rem] leading-[1.6] text-white/85">{HERO.subline}</p>
          <div className="flex shrink-0 items-center gap-1">
            <Pill variant="light" onClick={handleGetStarted}>
              {HERO.primaryCta}
            </Pill>
            <Pill variant="ghostLight" onClick={() => openDemo()}>
              {HERO.secondaryCta}
            </Pill>
          </div>
        </div>

        <ul className="mt-8 flex flex-wrap gap-x-7 gap-y-3">
          {HERO.bullets.map((bullet) => (
            <li key={bullet} className="flex items-center gap-2 text-[0.9375rem] text-white/85">
              <Check className="size-4 shrink-0" strokeWidth={2.5} />
              {bullet}
            </li>
          ))}
        </ul>

        {/* the real command center, clipped by the fold */}
        <div className="relative mt-14 sm:mt-16">
          <div className="rounded-t-[1.25rem] border-x border-t border-white/25 bg-white/[0.14] p-2 pb-0 backdrop-blur-[2px]">
            <div className="overflow-hidden rounded-t-[0.9rem]">
              <Screenshot
                src={HERO.visual}
                ratio="16 / 9"
                priority
                className="rounded-t-[0.9rem] rounded-b-none"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
