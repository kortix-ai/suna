'use client';

import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { AppPreview } from '@/features/marketing/v2/app-preview';
import { HERO, LOGOS } from '@/features/marketing/v2/content';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useCallback } from 'react';

export function Hero() {
  const { user } = useAuth();
  const openDemo = useRequestDemo();

  const handleGetStarted = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section className="relative isolate overflow-hidden">
      {/* the field: Kortix blue, lightening toward the bottom so the product
          shot dissolves straight into the page */}
      <div
        aria-hidden
        data-a11y-decorative
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(178deg,var(--field-deep)_0%,var(--field-mid)_46%,var(--field-soft)_74%,var(--background)_100%)]"
        style={
          {
            '--field-deep': 'color-mix(in oklab, var(--kortix-blue) 78%, #0d2a4d)',
            '--field-mid': 'color-mix(in oklab, var(--kortix-blue) 62%, #14335a)',
            '--field-soft': 'color-mix(in oklab, var(--kortix-blue) 16%, var(--background))',
          } as React.CSSProperties
        }
      />
      <div
        aria-hidden
        data-a11y-decorative
        className="pointer-events-none absolute inset-0 -z-10 opacity-70 [background:radial-gradient(70%_45%_at_82%_8%,rgba(255,255,255,0.30)_0%,transparent_60%),radial-gradient(50%_40%_at_8%_78%,rgba(255,255,255,0.22)_0%,transparent_65%)]"
      />

      <div className="mx-auto max-w-6xl px-6 pt-36 sm:pt-44">
        <h1 className="max-w-4xl text-[2.75rem] leading-[1.04] font-medium tracking-[-0.02em] text-white sm:text-6xl lg:text-[4.5rem]">
          {HERO.headline.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </h1>

        <div className="mt-12 flex flex-col gap-6 sm:mt-14 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-md text-[1.0625rem] leading-relaxed text-white/85">{HERO.subline}</p>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => openDemo()}
              className="flex h-11 cursor-pointer items-center rounded-full bg-white px-6 text-sm font-medium text-neutral-900 transition-colors hover:bg-white/90"
            >
              {HERO.primaryCta}
            </button>
            <button
              type="button"
              onClick={handleGetStarted}
              className="flex h-11 cursor-pointer items-center rounded-full px-5 text-sm font-medium text-white transition-colors hover:bg-white/15"
            >
              {HERO.secondaryCta}
            </button>
          </div>
        </div>

        {/* the product shot, clipped by the fold */}
        <div className="relative mt-14 sm:mt-16">
          <div className="rounded-t-2xl border-x border-t border-white/25 bg-white/15 p-1.5 pb-0 shadow-[0_-1px_60px_rgba(0,0,0,0.10)] backdrop-blur-sm">
            <div className="h-[30rem] overflow-hidden rounded-t-xl bg-white sm:h-[34rem]">
              <AppPreview />
            </div>
          </div>
          <div
            aria-hidden
            data-a11y-decorative
            className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[color-mix(in_oklab,var(--kortix-blue)_10%,var(--background))]"
          />
        </div>
      </div>

      <LogoWall />
    </section>
  );
}

function LogoWall() {
  return (
    <div className="bg-background relative">
      <div className="mx-auto max-w-6xl px-6 py-14 sm:py-16">
        <div className="grid grid-cols-2 items-center gap-x-8 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
          {LOGOS.map((name) => (
            <span
              key={name}
              className="text-muted-foreground/45 text-center text-sm font-semibold tracking-[0.14em] uppercase"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
