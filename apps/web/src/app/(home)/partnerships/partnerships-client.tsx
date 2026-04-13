'use client';

import { cn } from '@/lib/utils';
import { useState, useEffect, useCallback } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import Cal, { getCalApi } from '@calcom/embed-react';
import { Reveal } from '@/components/home/reveal';

const CAL_LINK = 'markokraemer/partnerships';
const CAL_NAMESPACE = 'partnerships';

export default function PartnershipsPageClient() {
  const [calOpen, setCalOpen] = useState(false);
  const [showFloatingCta, setShowFloatingCta] = useState(false);

  useEffect(() => {
    (async function () {
      const cal = await getCalApi({ namespace: CAL_NAMESPACE });
      cal('ui', { hideEventTypeDetails: true, layout: 'month_view' });
    })();
  }, []);

  useEffect(() => {
    const onScroll = () => setShowFloatingCta(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const openCal = useCallback(() => setCalOpen(true), []);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">

        {/* Hero */}
        <Reveal>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-5">
            Partnerships
          </h1>
        </Reveal>

        <Reveal delay={0.08}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
            We work with a handful of selected companies to build autonomous operations — the same way we build them for ourselves. Kortix leadership and engineers, embedded with your team.
          </p>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl mt-4">
            We learn from every engagement. That knowledge feeds back into everything we build. You get your operations actually automated — by the team that does this every day for their own companies. Our full methodology, knowledge, and processes — shared openly.
          </p>
        </Reveal>

        {/* Price */}
        <Reveal delay={0.2}>
          <div className="mt-14 p-6 rounded-lg border border-border bg-muted/5">
            <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2">
              Monthly Retainer
            </p>
            <p className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground">
              $20,000<span className="text-base font-normal text-muted-foreground">/month</span>
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Kortix leadership and engineers embedded with your team. Cancel anytime.
            </p>
          </div>
        </Reveal>

        {/* How it works */}
        <Reveal>
          <div className="mt-14">
            <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-5">
              How It Works
            </h2>
            <div className="space-y-6">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Phase 1</p>
                <p className="text-base font-medium text-foreground">Understand</p>
                <p className="text-base text-muted-foreground leading-relaxed mt-1.5">
                  We go deep. We talk to you, your team, your operators. We map every process — inputs, outputs, the black boxes where humans are doing repetitive work day-to-day. What{"'"}s actually happening, not what the org chart says.
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Phase 2</p>
                <p className="text-base font-medium text-foreground">Build & Deploy</p>
                <p className="text-base text-muted-foreground leading-relaxed mt-1.5">
                  We build autonomous operations on Kortix — agents, automations, autonomous teams — wired into your tools and data. Fully deployed, in production. This requires low politics, low bureaucracy, and real access. Credentials, systems, green lights. We need ownership to move. This is a partnership, not a consulting engagement.
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Ongoing</p>
                <p className="text-base font-medium text-foreground">Operate & Expand</p>
                <p className="text-base text-muted-foreground leading-relaxed mt-1.5">
                  We stay. Optimizing what{"'"}s running, expanding into new workflows, increasing autonomy — progressively replacing manual process with systems that run themselves.
                </p>
              </div>
            </div>
          </div>
        </Reveal>

        {/* CTA */}
        <Reveal>
          <div className="mt-14 pt-8 border-t border-border">
            <p className="text-base text-muted-foreground leading-relaxed">
              Also open to joint ventures and deeper structures beyond a retainer.
            </p>

            <Button
              size="lg"
              className="h-11 px-6 mt-5 text-sm rounded-full"
              onClick={openCal}
            >
              Schedule a call<ArrowRight className="ml-1.5 size-3.5" />
            </Button>

            <div className="flex flex-col gap-1.5 mt-5">
              <a
                href="mailto:marko@kortix.com"
                className="text-base text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors w-fit"
              >
                marko@kortix.com
              </a>
              <a
                href="https://x.com/markokraemer"
                target="_blank"
                rel="noopener noreferrer"
                className="text-base text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors w-fit"
              >
                @markokraemer
              </a>
              <a
                href="https://www.linkedin.com/in/markokraemer/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-base text-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors w-fit"
              >
                linkedin.com/in/markokraemer
              </a>
            </div>
          </div>
        </Reveal>

        {/* Bottom spacing for floating CTA clearance */}
        <div className="h-20" />
      </div>

      {/* Floating CTA Bar — commented out for now
      <div
        className={cn('fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-1.5 py-1.5 rounded-full border border-border bg-background/95 backdrop-blur-md transition-colors duration-300', 
          showFloatingCta ? 'translate-y-0 opacity-100' : 'translate-y-20 opacity-0 pointer-events-none'
        )}
      >
        <Button
          size="sm"
          className="px-5 text-xs rounded-full font-medium"
          onClick={openCal}
        >
          Schedule a call<ArrowRight className="ml-1.5 size-3" />
        </Button>
      </div>
      */}

      {/* ═══ Cal.com Modal ═══ */}
      <Dialog open={calOpen} onOpenChange={setCalOpen}>
        <DialogContent className="p-0 gap-0 border-none max-w-[min(700px,95vw)] rounded-xl overflow-hidden">
          <DialogTitle className="sr-only">
            Schedule a Partnerships Call
          </DialogTitle>
          <div className="bg-white dark:bg-[#171717] h-[600px] sm:h-[700px] overflow-auto">
            <Cal
              namespace={CAL_NAMESPACE}
              calLink={CAL_LINK}
              style={{ width: '100%', height: '100%' }}
              config={{
                layout: 'month_view',
                hideEventTypeDetails: 'false',
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
