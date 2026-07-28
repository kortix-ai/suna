'use client';

import { SECURITY } from '@/features/marketing/v2/content';
import { CheckLine } from '@/features/marketing/v2/primitives';
import Link from 'next/link';

export function SecuritySection() {
  return (
    <section id="security" className="scroll-mt-24 px-6 py-10">
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-neutral-950 px-6 py-16 sm:px-12 sm:py-20">
        <div
          aria-hidden
          data-a11y-decorative
          className="pointer-events-none absolute inset-0 [background:radial-gradient(60%_50%_at_85%_10%,color-mix(in_oklab,var(--kortix-blue)_22%,transparent)_0%,transparent_70%)]"
        />

        <div className="relative grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
          <div>
            <h2 className="text-[1.625rem] leading-[1.15] font-medium tracking-[-0.02em] text-white sm:text-[2.25rem]">
              {SECURITY.heading.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </h2>
            <p className="mt-5 text-[1.0625rem] leading-relaxed text-white/60">
              {SECURITY.subheading}
            </p>
            <Link
              href="/enterprise"
              className="mt-8 inline-flex h-11 items-center rounded-full bg-white px-6 text-sm font-medium text-neutral-900 transition-colors hover:bg-white/90"
            >
              {SECURITY.cta}
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:justify-items-end">
            {SECURITY.badges.map((badge) => (
              <div
                key={badge}
                className="flex aspect-square items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04] p-3 text-center text-xs leading-tight font-medium text-white/80"
              >
                {badge}
              </div>
            ))}
          </div>
        </div>

        <div className="relative mt-16 grid gap-8 border-t border-white/[0.08] pt-10 md:grid-cols-3 md:gap-10">
          {SECURITY.points.map((point) => (
            <div key={point.name}>
              <CheckLine tone="dark">
                <span className="font-medium">{point.name}</span>
              </CheckLine>
              <p className="mt-2 pl-[1.625rem] text-sm leading-relaxed text-white/55">
                {point.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
