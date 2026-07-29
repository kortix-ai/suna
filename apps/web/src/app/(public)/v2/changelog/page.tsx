'use client';

import { CtaBand } from '@/features/marketing/v2/commercial';
import { HeroSection } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W, Pill } from '@/features/marketing/v2/primitives';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

/**
 * The real release notes are generated in the repo, so this page points at them
 * rather than restating them. Every destination below is a live URL.
 */
const WHERE = [
  {
    name: 'Releases',
    description: 'Every tagged version with its notes.',
    href: 'https://github.com/kortix-ai/suna/releases',
  },
  {
    name: 'Commits',
    description: 'The full history, including every change an agent opened and a person approved.',
    href: 'https://github.com/kortix-ai/suna/commits/main',
  },
  {
    name: 'Docs',
    description: 'What changed in the CLI, the SDK, and kortix.yaml, kept alongside the reference.',
    href: '/docs',
  },
];

export default function ChangelogPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Every release, in the open."
        body="Kortix is open source, so the changelog is not a marketing artifact — it is the release notes generated from what actually shipped, published in the repo the product is built from."
        visual="none"
      />

      <section id="where" className="scroll-mt-24 py-20 sm:py-28">
        <div className={MAX_W}>
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
            <div>
              <Display lines="Where to follow along." />
              <Lead className="mt-6">Three places, all authoritative.</Lead>
            </div>
            <ul>
              {WHERE.map((entry) => (
                <li key={entry.name} className="border-border border-t">
                  <Link href={entry.href} className="group block py-6">
                    <p className="text-foreground flex items-center gap-1.5 text-[1.0625rem] font-medium">
                      {entry.name}
                      <ArrowUpRight className="text-muted-foreground size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </p>
                    <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.6]">
                      {entry.description}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <CtaBand
        id="cta"
        heading="Read the code behind the release."
        body="The repo is the product. Star it, fork it, or self-host the exact version you just read about."
      >
        <Pill as="a" href="https://github.com/kortix-ai/suna">
          Open the repo
        </Pill>
        <Pill as="a" href="/v2/self-hosted" variant="soft">
          Self-host it
        </Pill>
      </CtaBand>
    </main>
  );
}
