import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ROLES } from './registry';
import {
  DefinitionRows,
  Eyebrow,
  Section,
  SectionDivider,
  SectionHeading,
  SOLUTIONS_MEASURE,
  SpecGrid,
} from './shared';

/**
 * `/solutions` — the hub the eight role pages hang off.
 *
 * It exists so the section has a front door for search and a place every role
 * page can point back to. The nav menu links straight to the roles, so this
 * page is never the only way in.
 *
 * Accuracy gate: `./types.ts`. It governs this page too.
 */
export function SolutionsHubPage(): ReactNode {
  return (
    <div className="bg-background relative">
      {/* ── hero ────────────────────────────────────────────────────────── */}
      <section className={cn(SOLUTIONS_MEASURE, 'relative pt-32 pb-12 sm:pt-36')}>
        <Reveal>
          <Badge variant="kortix" className="rounded">
            Solutions
          </Badge>
          <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
            One platform. Eight teams with completely different work.
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
            The same project, the same connectors, the same memory — and eight different jobs
            underneath. Each team writes the skills for its own work, and nobody stands up a second
            system to do it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">Get started</Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/contact">Talk to us</Link>
            </Button>
          </div>
          <p className="text-muted-foreground mt-6 font-mono text-xs tracking-wider uppercase">
            Pick the team whose week you want back
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <SpecGrid
            specs={[
              { k: 'Every session', v: 'Its own cloud computer, on its own branch' },
              { k: 'Work lands', v: 'Through a change request' },
              { k: 'Merge', v: 'Default-deny for agents' },
              { k: 'Approval gates', v: 'Off until you set them' },
            ]}
          />
        </Reveal>
      </section>

      <SectionDivider />

      {/* ── the eight roles ─────────────────────────────────────────────── */}
      <Section id="roles">
        <SectionHeading
          eyebrow="By role"
          title="Start with the work, not the platform."
          sub="Every page below is written about that team's actual week — what it can hand off, which connectors make sense for it, and what the output looks like when it comes back."
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
        <SectionHeading
          eyebrow="What never changes"
          title="Eight kinds of work. One set of rules underneath."
          sub="The pages differ because the work differs. What sits under all of them is identical, and it is worth reading once rather than eight times."
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

      {/* ── closing ─────────────────────────────────────────────────────── */}
      <Section id="cta">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-6 rounded-sm border p-8 sm:p-12">
            <Badge variant="kortix" className="rounded">
              Get started
            </Badge>
            <h2 className="text-foreground max-w-2xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-4xl">
              Start with one team. The rest of the company is the same project.
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or
              your own on-prem network.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="xl" asChild>
                <Link href="/auth">Get started</Link>
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href="/pricing">See pricing</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </Section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
