'use client';

import { SECURITY } from '@/features/marketing/v2/content';
import { CheckLine, Display, Lead, Pill } from '@/features/marketing/v2/primitives';
import { cn } from '@/lib/utils';

/** The dark trust panel. */
export function SecuritySection() {
  return (
    <section id="security" className="scroll-mt-24 px-6 py-6">
      <div className="relative mx-auto w-full max-w-[68rem] overflow-hidden rounded-[1.75rem] bg-[#0d0f13]">
        <div
          aria-hidden
          data-a11y-decorative
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(65% 55% at 82% 8%, color-mix(in oklab, var(--kortix-blue) 26%, transparent) 0%, transparent 68%)',
          }}
        />

        <div className="relative px-8 pt-14 pb-12 sm:px-14 sm:pt-16">
          <div className="grid gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
            <div>
              <Display lines={SECURITY.heading} tone="inverse" />
              <Lead tone="inverse" className="mt-6">
                {SECURITY.subheading}
              </Lead>
              <Pill as="a" href="/enterprise" variant="light" className="mt-9">
                {SECURITY.cta}
              </Pill>
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:justify-items-end">
              {SECURITY.badges.map((badge, i) => (
                <Badge key={badge} label={badge} round={i >= 4} />
              ))}
            </div>
          </div>

          <div className="mt-16 grid gap-10 border-t border-white/10 pt-12 md:grid-cols-3">
            {SECURITY.points.map((point) => (
              <div key={point.name}>
                <CheckLine tone="inverse">
                  <span className="font-medium">{point.name}</span>
                </CheckLine>
                <p className="mt-2.5 pl-[1.75rem] text-[0.9375rem] leading-[1.55] text-white/55">
                  {point.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Shield / seal, echoing the compliance marks Tembo uses. */
function Badge({ label, round }: { label: string; round?: boolean }) {
  return (
    <div
      className="flex aspect-square w-full max-w-[7.5rem] items-center justify-center border border-white/[0.09] p-3 text-center text-[11px] leading-tight font-medium text-white/85"
      style={{
        // shield silhouette for the certifications, a seal for the regulations
        borderRadius: round ? '9999px' : '1rem 1rem 45% 45%',
        background:
          'linear-gradient(160deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.03) 100%)',
      }}
    >
      <span className={round ? '' : 'mb-2'}>{label}</span>
    </div>
  );
}
