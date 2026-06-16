'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import { INTEGRATIONS } from '@/features/marketing/marketing-pages';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { HiArrowRight } from 'react-icons/hi2';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

const CAPABILITIES = [
  'Read and write data in real time, securely',
  'Combine it with your other tools in a single run',
  'Run on a schedule and post results to Slack',
  'Package the workflow as a skill the whole team reuses',
];

export default function IntegrationPage() {
  const params = useParams();
  const slug = String(params?.slug ?? '');
  const it = INTEGRATIONS.find((x) => x.slug === slug);

  if (!it) {
    return (
      <main className="bg-background flex min-h-[60vh] flex-col items-center justify-center gap-4 pt-32 text-center">
        <p className="text-muted-foreground">Integration not found.</p>
        <Button asChild>
          <Link href="/integrations">All integrations</Link>
        </Button>
      </main>
    );
  }

  return (
    <main className="bg-background relative pt-32">
      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <div className="mb-6 flex items-center gap-3">
            <span className="border-border bg-background flex size-12 items-center justify-center overflow-hidden rounded-xl border">
              <img src={favicon(it.domain)} alt={it.name} width={26} height={26} />
            </span>
            <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
              {it.category}
            </span>
          </div>
          <h1 className="text-foreground max-w-3xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
            Your AI coworker for {it.name}
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">{it.blurb}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">
                Connect {it.name} <HiArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link href="/integrations">All integrations</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
          What Kortix can do with {it.name}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CAPABILITIES.map((cap, i) => (
            <Reveal key={cap} delay={i * 0.06}>
              <div className="border-border bg-card flex items-start gap-3 rounded-sm border p-6">
                <KortixAsterisk index={i} variant="solid" />
                <p className="text-foreground text-[15px] leading-relaxed">{cap}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-6 lg:px-0">
        <Reveal>
          <div className="border-border bg-card text-muted-foreground rounded-sm border p-6 text-sm leading-relaxed sm:p-8">
            <span className="text-foreground font-medium">One-click, self-healing.</span> An admin
            connects {it.name} once via OAuth — the credential is stored encrypted, never exposed to
            the model, and shared securely across your org. If a token expires, Kortix refreshes it
            or asks you to reconnect in plain language. No config files, no broken automations.
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-16 max-w-6xl px-6 pb-28 lg:px-0">
        <Reveal>
          <div className="border-border bg-card flex flex-col items-start gap-5 rounded-sm border p-8 sm:p-12">
            <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
              Put {it.name} to work
            </h2>
            <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
              Connect it and hand Kortix a real task. Free to start, yours to own and self-host.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link href="/auth">
                  Get started <HiArrowRight className="size-4" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/enterprise">Talk to sales</Link>
              </Button>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
