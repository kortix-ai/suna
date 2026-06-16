'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { Check, FileText } from 'lucide-react';
import Link from 'next/link';
import { useCallback } from 'react';
import { HiArrowRight } from 'react-icons/hi2';
import { HERO } from './narrative';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

function HeroConvo() {
  return (
    <div className="bg-border dark:bg-background rounded-xl p-1 shadow-sm">
      <div className="bg-background dark:bg-primary/7 flex items-center gap-2 rounded-t-lg px-3.5 py-2.5">
        <span className="border-border bg-background flex size-5 items-center justify-center overflow-hidden rounded">
          <img src={favicon('slack.com')} alt="Slack" width={13} height={13} />
        </span>
        <span className="text-muted-foreground font-mono text-xs">#finance</span>
      </div>
      <div className="bg-background dark:bg-primary/7 flex flex-col gap-3 rounded-b-lg p-5">
        <div className="bg-muted/50 text-foreground ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm px-3 py-2 text-sm">
          @Kortix pull last month’s numbers and build the board deck
        </div>
        <div className="flex items-start gap-2">
          <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold">
            K
          </span>
          <div className="bg-card border-border text-foreground w-fit max-w-[85%] rounded-lg rounded-tl-sm border px-3 py-2 text-sm">
            On it — pulling from Stripe and the CRM…
          </div>
        </div>
        <div className="border-border bg-card ml-8 flex items-center gap-3 rounded-md border p-3">
          <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border">
            <FileText className="text-foreground size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-foreground truncate text-sm font-medium">board-deck-q3.pdf</div>
            <div className="text-muted-foreground text-xs">18 slides · charts · sources</div>
          </div>
          <Check className="text-kortix-green ml-auto size-4" />
        </div>
        <div className="text-muted-foreground pl-8 text-xs">Delivered in 3m 12s</div>
      </div>
    </div>
  );
}

const Hero = () => {
  const { user } = useAuth();

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <section id="hero" className="relative overflow-hidden px-6 pt-32 pb-12 sm:py-36">
      <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
        <KortixLetterField seed={3382} />
      </div>
      <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
        <WallpaperBackground wallpaperId="brandmark" />
      </div>

      <div className="relative z-20 mx-auto w-full max-w-6xl">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left — message */}
          <div>
            <Badge variant="update" className="rounded-full">
              {HERO.badge}
            </Badge>
            <h1 className="text-foreground mt-5 text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl lg:text-6xl">
              {HERO.titleLead}
              <br />
              <span className="text-muted-foreground">{HERO.titleAccent}</span>
            </h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
              {HERO.description}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="xl" onClick={handleLaunch}>
                {HERO.primaryCta}
                <HiArrowRight className="size-4" />
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href={'/enterprise'}>{HERO.secondaryCta}</Link>
              </Button>
            </div>
          </div>

          {/* Right — proof */}
          <div className="lg:pl-4">
            <HeroConvo />
          </div>
        </div>

        {/* Three core benefits */}
        <div className="border-border mt-16 grid grid-cols-1 gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-3 sm:mt-20">
          {HERO.benefits.map((b) => (
            <div key={b.title} className="bg-background p-6">
              <h3 className="text-foreground text-base font-medium tracking-tight">{b.title}</h3>
              <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{b.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Hero;
