'use client';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import {
  Boxes,
  Eye,
  GitFork,
  KeyRound,
  Layers,
  Lock,
  ServerCog,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { HiArrowRight } from 'react-icons/hi2';

const PILLARS = [
  {
    icon: Boxes,
    title: 'Isolated by session',
    body: 'Every session runs in its own sandbox on its own branch. Thousands of agents run in parallel and nothing collides.',
  },
  {
    icon: KeyRound,
    title: 'Secrets never exposed',
    body: 'Credentials are injected at sandbox boot and never reach the model. Agents hold one scoped token — never your API keys.',
  },
  {
    icon: Eye,
    title: 'Every action audited',
    body: 'Every tool call, commit and message is logged to an immutable trail. Nothing the workforce does is a black box.',
  },
  {
    icon: ShieldCheck,
    title: 'SSO + RBAC',
    body: 'SAML/OIDC single sign-on, role-based access and per-tool permissions — control exactly who can run and approve what.',
  },
  {
    icon: Layers,
    title: 'Bring your own models',
    body: 'Route to any provider with your own keys. Your prompts and data are never used to train anyone’s models.',
  },
  {
    icon: GitFork,
    title: 'Open-source & self-hostable',
    body: 'Read every line, run it on your own infra. The architecture is the security model — and it’s yours to inspect.',
  },
];

const DEPLOYMENTS = ['Managed cloud', 'Your VPC', 'On-prem', 'Air-gapped'];

const COMPLIANCE = [
  { title: 'SOC 2', body: 'Type II in progress — controls and monitoring in place today.' },
  { title: 'Data residency', body: 'Self-host in any region, or keep everything inside your own VPC.' },
  { title: 'No training on your data', body: 'Your data stays yours. Nothing is used to train models — ever.' },
];

export default function SecurityPage() {
  return (
    <main className="bg-background relative pt-32">
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <Badge variant="update" className="rounded-full">
            Security & control
          </Badge>
          <h1 className="text-foreground mt-5 max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            Yours to control.
            <br />
            <span className="text-muted-foreground">Yours to keep.</span>
          </h1>
          <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
            Most AI platforms ask you to hand your data, your tools and your moat to a vendor. Kortix
            is open-source and runs on infrastructure you own — the architecture is the security
            model, and you can read every line of it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/enterprise">
                Talk to sales <HiArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/docs">Read the docs</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-20 max-w-6xl px-6 sm:mt-28 lg:px-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.06}>
              <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
                <span className="border-border bg-background text-foreground flex size-11 items-center justify-center rounded-lg border">
                  <p.icon className="size-5" />
                </span>
                <h3 className="text-foreground mt-5 text-lg font-medium tracking-tight">{p.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Deployment */}
      <section className="mx-auto mt-20 max-w-6xl px-6 sm:mt-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card overflow-hidden rounded-sm border p-8 sm:p-12">
            <div className="flex items-center gap-3">
              <ServerCog className="text-foreground size-5" />
              <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
                Run it wherever you need to
              </h2>
            </div>
            <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
              The same product, deployed on your terms. One command to self-host — managed cloud for
              speed, your own VPC or on-prem for control, air-gapped when nothing can leave.
            </p>
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {DEPLOYMENTS.map((d, i) => (
                <div
                  key={d}
                  className={cn(
                    'border-border bg-background flex items-center gap-2.5 rounded-sm border px-4 py-3.5',
                  )}
                >
                  <Lock className="text-kortix-green size-4 shrink-0" />
                  <span className="text-foreground text-sm font-medium">{d}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </section>

      {/* Compliance */}
      <section className="mx-auto mt-20 max-w-6xl px-6 sm:mt-28 lg:px-0">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COMPLIANCE.map((c, i) => (
            <Reveal key={c.title} delay={i * 0.06}>
              <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
                <h3 className="text-foreground text-lg font-medium tracking-tight">{c.title}</h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{c.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-20 max-w-6xl px-6 pb-28 sm:mt-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              Want the deep dive?
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              We’ll walk your security team through the architecture, data handling and deployment
              options — and hand over everything you need for review.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/enterprise">
                  Talk to sales <HiArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="https://github.com/kortix-ai/suna">Read the source</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
