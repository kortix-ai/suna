'use client';

import { PageHead, Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, FileText } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

const CR = 42;

const FILES: { name: string; add: number; del: number }[] = [
  { name: 'revenue-brief.md', add: 128, del: 0 },
  { name: 'summary.md', add: 14, del: 2 },
  { name: 'charts/mrr.svg', add: 1, del: 0 },
];

export function Step4ShipCli() {
  const reduced = useReducedMotion();
  const [merged, setMerged] = useState(false);

  useEffect(() => {
    if (reduced) {
      setMerged(true);
      return;
    }
    const id = setTimeout(() => setMerged(true), 2400);
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
          <PageHead title="Review" sub="Finished work comes back as a change request you approve" />

          <motion.div {...enter(0)}>
            <Panel
              title={`Change request #${CR}`}
              count="acme-ops"
              action={
                merged ? (
                  <Badge size="sm" variant="success" className="gap-1">
                    <Check className="size-3" /> merged
                  </Badge>
                ) : (
                  <Badge size="sm" variant="outline">
                    ready for review
                  </Badge>
                )
              }
            >
              <div className="border-border border-b px-4 py-3">
                <div className="text-foreground text-sm font-medium">Monday revenue brief</div>
                <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                  Drafted from Stripe, HubSpot, and Linear — MRR, pipeline, and blockers in one
                  brief.
                </p>
              </div>

              <div className="divide-border divide-y">
                {FILES.map((file) => (
                  <div key={file.name} className="flex items-center gap-3 px-4 py-2.5">
                    <FileText className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
                      {file.name}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-emerald-600 dark:text-emerald-500">
                      +{file.add}
                    </span>
                    {file.del > 0 && (
                      <span className="shrink-0 font-mono text-xs text-rose-500">−{file.del}</span>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          </motion.div>

          <motion.div {...enter(1)} className="mt-4">
            <AnimatePresence mode="wait" initial={false}>
              {merged ? (
                <motion.div
                  key="merged"
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="border-kortix-green/30 bg-kortix-green/5 text-foreground flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm"
                >
                  <Check className="text-kortix-green size-4 shrink-0" />
                  Approved and merged to <span className="font-mono text-xs">main</span> — now part
                  of the company system.
                </motion.div>
              ) : (
                <motion.div
                  key="pending"
                  initial={false}
                  exit={reduced ? undefined : { opacity: 0, y: -6 }}
                  className="flex items-center gap-2"
                >
                  <Button variant="default" size="sm" className="gap-1.5">
                    <Check className="size-3.5" /> Approve &amp; merge
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Summary and diff visible before anything ships.
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
