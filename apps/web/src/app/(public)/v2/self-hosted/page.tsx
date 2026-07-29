'use client';

import { CtaPair, CtaSection, GridSection, ListSection } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W } from '@/features/marketing/v2/primitives';
import { RealVisual } from '@/features/marketing/v2/real-visual';
import { ChecklistSplit } from '@/features/marketing/v2/trust-sections';
import { cn } from '@/lib/utils';

/**
 * For teams whose only acceptable answer is that the data never leaves. The
 * hero is composed by hand so the install command reads as a command, and the
 * requirements are an unnumbered spec table rather than a sequence of steps —
 * they are conditions to satisfy, not an order to follow.
 */
export default function SelfHostedPage() {
  return (
    <main className="bg-background">
      <section id="hero" className="scroll-mt-24 pt-32 sm:pt-40">
        <div className={MAX_W}>
          <div className="grid items-end gap-10 lg:grid-cols-2 lg:gap-16">
            <Display
              lines="Self-host Kortix in your own infrastructure."
              as="h1"
              className="sm:text-[3.5rem]"
            />
            <div className="lg:pb-2">
              <Lead>
                <code className="text-foreground bg-foreground/[0.06] rounded-md px-1.5 py-0.5 font-mono text-[0.9375rem]">
                  kortix self-host init
                </code>{' '}
                runs the entire platform from Docker images — in your VPC, on-prem, or fully
                air-gapped. Same product everywhere. Nothing phones home.
              </Lead>
              <div className="mt-8">
                <CtaPair />
              </div>
            </div>
          </div>
        </div>

        <div className={cn(MAX_W, 'mt-16')}>
          <RealVisual name="slabs" size="lg" priority />
        </div>
      </section>

      <GridSection
        id="who"
        heading="Built for teams that cannot send data out."
        body="Four situations where self-hosting is not a preference."
        columns={4}
        bullets={[
          'Regulated industries. Financial services, healthcare, and government organisations.',
          'Security-first teams. Companies that cannot send their data to a third-party environment.',
          'Any cloud provider. Organisations operating inside their own AWS, Azure, or GCP accounts.',
          'Air-gapped networks. Teams in fully isolated environments with no public internet access.',
        ]}
      />

      <ChecklistSplit
        id="same-product"
        tone="muted"
        heading="The same product, on your metal."
        body="Self-hosted is not a reduced build. Agents, skills, connectors, channels, triggers, sandboxes, and the change-request flow all work exactly as they do on Kortix Cloud."
        bullets={[
          'Feels as simple as chat, with code underneath',
          'Same agents, skills, and connectors',
          'Your data, your config, your model choice',
          'Clone the repo and walk away whenever you want',
        ]}
      />

      <ListSection
        id="requirements"
        heading="What it takes to run it."
        body="The install is documented end to end, and every release is pinned so you roll on your own schedule."
        bullets={[
          'Runtime — Kubernetes, or Docker Compose for a single-node install.',
          'Database — Postgres 15+, yours or provisioned by the installer.',
          'Sandboxes — microVM-capable hosts, sized to your concurrency.',
          'Models — any provider you can reach, including a private endpoint.',
          'Identity — your SAML or OIDC provider.',
          'Network — no outbound requirement. Air-gapped installs supported.',
          'Updates — pinned releases you roll yourself, on your schedule.',
        ]}
      />

      <CtaSection
        id="cta"
        heading="Deploy Kortix in the environment you already trust."
        body="Tell us about your infrastructure and we will map the install with you."
      />
    </main>
  );
}
