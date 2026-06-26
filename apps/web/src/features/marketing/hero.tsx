'use client';

import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Cpu, KeyRound, Unlock, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

const OWNERSHIP = [
  { label: 'Open source', icon: Unlock },
  { label: 'You own everything', icon: UserCheck },
  { label: 'Bring your own API key', icon: KeyRound },
  { label: 'Run it on any model', icon: Cpu },
] as const;

const Hero = () => {
  const { user } = useAuth();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="hero" className="relative overflow-hidden px-6 pt-36 pb-20 sm:pt-44 sm:pb-28">
      <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
        <KortixLetterField seed={3382} />
      </div>

      <div className="relative z-20 mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <h1 className="text-foreground text-4xl leading-[1.08] font-medium tracking-tight text-balance md:text-6xl">
          Build the AI workforce
          <br />
          <span className="text-muted-foreground">that runs your company.</span>
        </h1>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-balance">
          Kortix is the open-source platform for AI agents that do real work across every team —
          connected to your tools, teachable and self-improving, and governed from one repo you own.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="xl" onClick={handleLaunch}>
            Launch Kortix
            <HiArrowRight className="size-4" />
          </Button>
          <Button size="xl" variant="secondary" asChild>
            <Link href={'/enterprise'}>Talk to sales</Link>
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {OWNERSHIP.map(({ label, icon: Icon }) => (
            <span
              key={label}
              className="border-border bg-background/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
            >
              <Icon className="text-foreground/70 size-3.5" />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Hero;
