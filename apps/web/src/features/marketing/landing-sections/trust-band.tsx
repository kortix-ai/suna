'use client';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Seal } from '@/features/marketing/kit/seal';
import {
  CpuIcon,
  HandPalmIcon,
  KeyIcon,
  ListChecksIcon,
  PlugsIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

// Claims follow kortix-brand/references/verbal/claims.md: SOC 2 Type I is
// verified; Type II is not mentioned (D17). GDPR is a posture we run. No ISO,
// no HIPAA: Kortix holds neither. Each cell is a claims.md row: Permissions,
// Approval gates, Audit, One sandbox per session, Secrets, Connector
// credentials, SSO, Models, Hosting.
const CELLS = [
  {
    icon: UsersThreeIcon,
    k: 'Access control',
    v: 'Per-resource permissions for people and agents, with roles and groups.',
  },
  {
    icon: HandPalmIcon,
    k: 'Guardrails',
    v: 'Allow, Ask or Block per tool. Agents wait for a person where you say so.',
  },
  { icon: ListChecksIcon, k: 'Full audit trail', v: 'Every action an agent or a person takes is recorded.' },
  {
    icon: CpuIcon,
    k: 'Isolated machines',
    v: 'Each session on its own machine. Secrets encrypted per project; connector credentials stay on the server.',
  },
  { icon: KeyIcon, k: 'Single sign-on', v: 'SAML 2.0 single sign-on and SCIM 2.0 directory sync.' },
  { icon: PlugsIcon, k: 'No lock-in', v: 'Any model with your own keys, on Kortix Cloud, your VPC or on-prem.' },
];

/**
 * Trust as one dark panel in both themes (the `dark` class scopes the dark
 * tokens onto it): the heading, six framed cells of what a security review
 * asks, then the SOC 2 row and the way into /security.
 */
export function TrustBand() {
  return (
    <section id="trust" className="scroll-mt-16 px-4 py-14 lg:px-17 lg:py-20">
      <div className="dark bg-muted text-foreground rounded-xl px-6 py-10 lg:px-14 lg:py-16">
        <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
          Everything IT needs to say yes.
          <span className="text-muted-foreground block">Agents for the whole team, without giving up control.</span>
        </h2>

        <ul className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:mt-12 lg:grid-cols-3">
          {CELLS.map(({ icon: Icon, k, v }) => (
            <li key={k} className="border-border flex flex-col gap-3 rounded-lg border p-5 lg:p-6">
              <Icon className="size-5" aria-hidden />
              <h3 className="text-base font-medium">{k}</h3>
              <p className="text-muted-foreground text-sm text-pretty">{v}</p>
            </li>
          ))}
        </ul>

        <div className="border-border mt-3 flex flex-col items-start justify-between gap-6 rounded-lg border p-5 sm:flex-row sm:items-center lg:p-6">
          <div className="flex items-center gap-5">
            <Seal name="SOC 2" detail="Type I" note="Verified" ornament="double" className="text-foreground size-20 shrink-0" />
            <div>
              <p className="text-base font-medium">SOC 2 Type I verified</p>
              <p className="text-muted-foreground mt-1 text-sm">GDPR operated. Open source, so your team can read every line.</p>
            </div>
          </div>
          <MarketingButton size="md" className="hit-area-y-1 shrink-0" asChild>
            <Link href="/security">Security at Kortix</Link>
          </MarketingButton>
        </div>
      </div>
    </section>
  );
}
