'use client';

import { PageHead, Panel, Row } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { cn } from '@/lib/utils';
import { CheckIcon, GitPullRequestIcon } from '@phosphor-icons/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

/**
 * Every surface here creates a session for real. Sources are the
 * `SessionInvocationSource` union plus the `backend` origin a service account
 * or PAT resolves to. Teams is deliberately absent — it ships behind an
 * operator switch, so it is not a claim this page can make.
 */
const SURFACES = ['Web', 'Slack', 'Mobile', 'CLI', 'API', 'Cron', 'Webhook'];

const CHANGES = [
  {
    title: 'Fix the billing webhook retry',
    meta: '7f2a1c94 · +48 −12 · kortix',
  },
  {
    title: 'Refresh the Monday revenue brief',
    meta: '31c9ab07 · +1 file · researcher',
  },
];

/** Layer 05 — one place to start the work, and one gate for where it lands. */
export function StepControlPlane(): ReactNode {
  const reduced = useReducedMotion();
  const [merged, setMerged] = useState(false);

  useEffect(() => {
    if (reduced) {
      setMerged(true);
      return;
    }
    const id = setTimeout(() => setMerged(true), 2600);
    return () => clearTimeout(id);
  }, [reduced]);

  return (
    <div className="relative h-full w-full">
      <WebPanelWrapper activeTab="review">
        <div className="flex h-full flex-col">
          <PageHead
            title="Change requests"
            sub="Session work lands as a diff you read first."
            action={
              <Badge size="sm" variant="outline" className="shrink-0">
                {merged ? '1 open' : '2 open'}
              </Badge>
            }
          />

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="space-y-3">
              <Panel title="Open">
              {CHANGES.map((change, index) => {
                const done = merged && index === 0;
                return (
                  <Row
                    key={change.title}
                    leading={
                      <span
                        className={cn(
                          'flex size-9 items-center justify-center rounded-sm transition-colors duration-300',
                          done ? 'bg-kortix-green/15' : 'bg-kortix-blue/15',
                        )}
                      >
                        {done ? (
                          <CheckIcon
                            weight="fill"
                            className="text-kortix-green size-4.5 shrink-0"
                          />
                        ) : (
                          <GitPullRequestIcon className="text-kortix-blue size-4.5 shrink-0" />
                        )}
                      </span>
                    }
                    title={change.title}
                    subtitle={<span className="font-mono text-[11px]">{change.meta}</span>}
                    trailing={
                      <Badge size="xs" variant={done ? 'success' : 'kortix'} className="shrink-0">
                        {done ? 'merged' : 'review'}
                      </Badge>
                    }
                  />
                );
              })}
            </Panel>

              <AnimatePresence mode="wait" initial={false}>
                {merged ? (
                  <motion.div
                    key="merged"
                    initial={reduced ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <InfoBanner tone="success" icon={CheckIcon} title="Merged into main">
                      Merging is a named grant in kortix.yaml. Narrow it to a person, a group or
                      nobody.
                    </InfoBanner>
                  </motion.div>
                ) : (
                  <motion.div
                    key="pending"
                    initial={false}
                    exit={reduced ? undefined : { opacity: 0, y: -6 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Button size="sm" className="gap-1.5">
                      <CheckIcon className="size-3.5 shrink-0" />
                      Merge
                    </Button>
                    <span className="text-muted-foreground text-xs">
                      Read the diff first — nothing lands until it is approved.
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="space-y-3">
              <Panel title="Started from" count="every surface starts the same session">
                <div className="flex flex-wrap gap-1.5 px-4 py-3">
                  {SURFACES.map((surface) => (
                    <span
                      key={surface}
                      className="border-border text-muted-foreground rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wide"
                    >
                      {surface}
                    </span>
                  ))}
                </div>
              </Panel>

              <Panel title="Lands as">
                <div className="text-muted-foreground space-y-1.5 px-4 py-3 font-mono text-[11.5px]">
                  <div>
                    <span className="text-kortix-green">+</span> a branch per session
                  </div>
                  <div>
                    <span className="text-kortix-green">+</span> a diff you read before it merges
                  </div>
                  <div>
                    <span className="text-kortix-green">+</span> a commit on main you can revert
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </WebPanelWrapper>
    </div>
  );
}
