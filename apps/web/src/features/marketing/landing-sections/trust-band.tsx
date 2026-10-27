'use client';

import { Seal } from '@/features/marketing/kit/seal';
import Link from 'next/link';

// Claims follow kortix-brand/references/verbal/claims.md: SOC 2 Type I is
// verified; Type II is not mentioned (D17). GDPR is a posture we run. No ISO,
// no HIPAA: Kortix holds neither. Each cell is a claims.md row: Permissions,
// Approval gates, Audit, One sandbox per session, Secrets, Connector
// credentials, SSO, Models, Hosting.
const CELLS = [
  {
    k: 'Access control',
    v: 'Per-resource permissions for people and agents, with roles and groups.',
  },
  {
    k: 'Guardrails',
    v: 'Allow, Ask or Block per tool. Agents wait for a person where you say so.',
  },
  { k: 'Full audit trail', v: 'Every action an agent or a person takes is recorded.' },
  {
    k: 'Isolated machines',
    v: 'Each session on its own machine. Secrets encrypted per project; connector credentials stay on the server.',
  },
  { k: 'Single sign-on', v: 'SAML 2.0 single sign-on and SCIM 2.0 directory sync.' },
  { k: 'No lock-in', v: 'Any model with your own keys, on Kortix Cloud, your VPC or on-prem.' },
];

/**
 * Trust: a two-tone heading, six cells of what a security review asks, then
 * one row with the SOC 2 seal and the way into /security.
 */
export function TrustBand() {
  return (
    <section id="trust" className="scroll-mt-16 py-24 lg:py-32">
      <h2 className="text-foreground px-8 text-xl font-medium tracking-tight text-balance md:text-2xl lg:px-28 lg:text-3xl">
        Everything IT needs to say yes.
        <span className="text-muted-foreground block">
          Agents for the whole team, without giving up control.
        </span>
      </h2>

      <div className="kx-rail-fade mt-12 border-y px-4 lg:px-17">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
          {CELLS.map((cell) => (
            <li key={cell.k} className="bg-background flex flex-col gap-2 p-6 lg:p-11">
              <h3 className="text-foreground text-base font-medium">{cell.k}</h3>
              <p className="text-muted-foreground text-sm text-pretty">{cell.v}</p>
            </li>
          ))}
        </ul>
        <div className="bg-card flex flex-col items-start justify-between gap-6 border-t px-6 py-8 sm:flex-row sm:items-center lg:px-11">
          <div className="flex items-center gap-5">
            <Seal name="SOC 2" detail="Type I" note="Verified" ornament="double" />
            <div>
              <p className="text-foreground text-base font-medium">SOC 2 Type I verified</p>
              <p className="text-muted-foreground mt-1 text-sm">
                GDPR operated. Open source, so your team can read every line.
              </p>
            </div>
          </div>
          <Link
            href="/security"
            className="text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex rounded-sm text-sm font-medium transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Security at Kortix
          </Link>
        </div>
      </div>
    </section>
  );
}
