import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SolutionsHeroVisual } from './hero-visual';
import { ROLES } from './registry';
import { DefinitionRows, Eyebrow, Section, SectionDivider } from './shared';

/**
 * `/solutions` — the hub the eight role pages hang off.
 *
 * It exists so the section has a front door for search and a place every role
 * page can point back to. The nav menu links straight to the roles, so this
 * page is never the only way in.
 *
 * Accuracy gate: `./types.ts`. It governs this page too.
 */
/** The four facts that hold across every role. */
const HUB_SPECS = [
  { k: 'Every session', v: 'Its own cloud computer, on its own branch' },
  { k: 'Work lands', v: 'Through a change request' },
  { k: 'Merge', v: 'Default-deny for agents' },
  { k: 'Approval gates', v: 'Off until you set them' },
] as const;

export function SolutionsHubPage(): ReactNode {
  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow="Solutions"
        title="One platform. Eight teams with completely different work."
        sub="The same project, the same connectors, the same memory — and eight different jobs underneath. Each team writes the skills for its own work, and nobody stands up a second system to do it."
        ctaPrimary="Get started"
        ctaPrimaryHref="/auth"
        ctaSecondary="Talk to us"
        ctaSecondaryHref="/contact"
        visual={<SolutionsHeroVisual specs={HUB_SPECS} />}
      />

      {/* ── the eight roles ─────────────────────────────────────────────── */}
      <Section id="roles">
        <SectionHeader
          eyebrow="By role"
          title="Start with the work, not the platform."
          description="Every page below is written about that team's actual week — what it can hand off, which connectors make sense for it, and what the output looks like when it comes back."
        />

        <Reveal delay={0.06}>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role, i) => (
              <li key={role.slug}>
                <Link
                  href={`/solutions/${role.slug}`}
                  className="border-border bg-card hover:bg-accent/40 flex h-full flex-col rounded-sm border p-6 transition-colors"
                >
                  <Eyebrow>{String(i + 1).padStart(2, '0')}</Eyebrow>
                  <span className="text-foreground mt-3 text-lg leading-tight font-medium">
                    {role.name}
                  </span>
                  <span className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
                    {role.navDescription}
                  </span>
                  <span className="text-muted-foreground mt-auto pt-6 font-mono text-[10px] tracking-widest uppercase">
                    Read →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── what does not change between them ───────────────────────────── */}
      <Section id="constant">
        <SectionHeader
          eyebrow="What never changes"
          title="Eight kinds of work. One set of rules underneath."
          description="The pages differ because the work differs. What sits under all of them is identical, and it is worth reading once rather than eight times."
        />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <DefinitionRows
              rows={[
                {
                  k: 'A session is a machine',
                  v: 'Every session boots its own disposable Linux computer and cuts its own branch. Thousands can run in parallel on one configuration without touching each other. The machine is real: the agent has a shell, a filesystem and the network.',
                },
                {
                  k: 'Work lands through a change request',
                  v: 'What an agent means to keep is committed on the session branch and proposed back toward main. Merge is default-deny for agents; an admin can grant project.cr.merge in kortix.yaml, and widening that grant is itself a reviewed change.',
                },
                {
                  k: 'Approval gates are off until you set them',
                  v: 'The shipped default is permissive — an action runs unless you have said otherwise. Set Ask on what should pause and Block on what should never happen, per action or with a pattern rule that can read the arguments in the call.',
                },
                {
                  k: 'Connector credentials never enter the machine',
                  v: 'The sandbox carries one project-scoped Kortix token and no third-party keys. The real credential is decrypted server-side and attached to the outbound call. A runtime secret you deliberately grant is different: it is a real environment value the agent can read.',
                },
                {
                  k: 'Everything is a file you own',
                  v: 'Agents, skills, connectors, triggers and memory are text in a git repo. You can read the whole company, diff what changed, and revert it. Open source and self-hostable — Kortix Cloud, your own VPC, or your own on-prem network.',
                },
              ]}
            />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/agent-computer">The agent computer</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/connectors">Connectors</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/security">Security</Link>
            </Button>
          </div>
        </Reveal>
      </Section>
    </div>
  );
}
