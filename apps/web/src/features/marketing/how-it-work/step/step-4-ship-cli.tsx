'use client';

import { PageHead } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { ArrowDown, Check, FileText } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

export function Step4ShipCli() {
  const reduced = useReducedMotion();
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (reduced) {
      setApproved(true);
      return;
    }
    const id = setTimeout(() => setApproved(true), 2400);
    return () => clearTimeout(id);
  }, [reduced]);

  const enter = (i: number) =>
    reduced
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { delay: 0.05 + i * 0.06, duration: 0.3, ease: 'easeOut' as const },
        };

  return (
    <div className="relative aspect-19/22 w-full overflow-visible">
      <WebPanelWrapper activeTab="review">
        <div className="flex h-full flex-col">
          <PageHead title="Review" sub="See what went in and what came back before you keep it" />

          <motion.div {...enter(0)} className="space-y-3">
            <div>
              <div className="text-muted-foreground mb-1.5 text-xs font-medium">Input</div>
              <div className="border-border bg-card rounded-md border px-4 py-3">
                <p className="text-foreground text-sm leading-snug">
                  Draft the Monday revenue brief
                </p>
                <p className="text-muted-foreground mt-1 text-xs">Stripe · HubSpot · Linear</p>
              </div>
            </div>

            <ArrowDown className="text-muted-foreground mx-auto size-4 shrink-0" aria-hidden />

            <div>
              <div className="text-muted-foreground mb-1.5 text-xs font-medium">Output</div>
              <div className="border-border bg-card rounded-md border px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="border-border bg-background text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md border">
                    <FileText className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-foreground text-sm font-medium">Monday revenue brief</div>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                      MRR, pipeline, and blockers in one doc — ready to share.
                    </p>
                  </div>
                  {approved ? (
                    <Badge size="sm" variant="success" className="shrink-0 gap-1">
                      <Check className="size-3" />
                      kept
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="outline" className="shrink-0">
                      ready
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div {...enter(1)} className="mt-4">
            <AnimatePresence mode="wait" initial={false}>
              {approved ? (
                <motion.div
                  key="approved"
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <InfoBanner tone="success" icon={Check} title="Approved">
                    This brief is now part of your workspace for the team to reuse.
                  </InfoBanner>
                </motion.div>
              ) : (
                <motion.div
                  key="pending"
                  initial={false}
                  exit={reduced ? undefined : { opacity: 0, y: -6 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <Button variant="default" size="sm" className="gap-1.5">
                    <Check className="size-3.5" />
                    Approve
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Read the output first — nothing ships until you say so.
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </WebPanelWrapper>
    </div>
  );
}
