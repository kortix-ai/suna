'use client';

import { ShieldCheckIcon } from '@phosphor-icons/react';
import { Seal, type Ornament } from '@/features/marketing/kit/seal';
import Link from 'next/link';

// Claims follow kortix-brand/references/verbal/claims.md: SOC 2 Type I is held,
// Type II is in progress (so its seal says so, never "Type II" alone), GDPR is
// a posture we run. No ISO, no HIPAA: Kortix holds neither.
const SEALS: { name: string; detail: string; note?: string; ornament: Ornament }[] = [
  { name: 'SOC 2', detail: 'Type I', ornament: 'double' },
  { name: 'SOC 2', detail: 'Type II', note: 'In progress', ornament: 'ticks' },
  { name: 'GDPR', detail: 'Operated', ornament: 'stars' },
];

// Each line is on /security (security-page/content.ts).
const PROMISES = [
  'Connector credentials stay on the server',
  'Secrets encrypted per project',
  'Each session on its own machine',
  'SAML SSO and SCIM',
  'Self-host in your VPC or on-prem',
];

/**
 * Trust, after Alfred's Trust section, in the landing page's border style: a
 * two-tone heading, then a band whose hairlines cross the page with the claim
 * on the left and the seals on the right, then the promises on one line.
 */
export function TrustBand() {
  return (
    <section id="trust" className="scroll-mt-16 py-24 lg:py-32">
      <h2 className="text-foreground px-8 text-xl font-medium tracking-tight text-balance md:text-2xl lg:px-28 lg:text-3xl">
        Built to survive a security review.
        <span className="text-muted-foreground block">Not to slip past one.</span>
      </h2>

      <div className="kx-rail-fade mt-12 border-y px-4 lg:px-17">
        <div className="bg-card grid grid-cols-1 gap-12 px-4 py-10 lg:grid-cols-12 lg:px-11">
          <div className="lg:col-span-5">
            <p className="text-muted-foreground max-w-sm text-base text-pretty">
              Kortix runs your company&apos;s work, so it has to pass your review. SOC 2 Type I is held
              and Type II is in progress.
            </p>
            <Link
              href="/security"
              className="text-foreground hover:text-muted-foreground outline-ring mt-8 inline-flex rounded-sm text-sm font-medium transition-colors duration-normal ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Security at Kortix
            </Link>
          </div>
          <ul className="flex flex-wrap items-center gap-4 lg:col-span-7 lg:justify-end">
            {SEALS.map((seal) => (
              <li key={`${seal.name} ${seal.detail}`}>
                <Seal {...seal} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-10 gap-y-3 px-8 pt-6 lg:px-28">
        {PROMISES.map((promise) => (
          <li key={promise} className="text-foreground flex items-center gap-2 text-sm">
            <ShieldCheckIcon weight="fill" className="text-ring size-4 shrink-0" />
            {promise}
          </li>
        ))}
      </ul>
    </section>
  );
}
