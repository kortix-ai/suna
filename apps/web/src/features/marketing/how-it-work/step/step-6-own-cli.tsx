'use client';

import { PageHead, Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { FileText, FolderGit2, Lightbulb, Repeat, TriangleAlert, Users } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ComponentType } from 'react';
import { WebPanelWrapper } from '../web-panel-wrapper';

type Captured = {
  icon: ComponentType<{ className?: string }>;
  kind: string;
  text: string;
};

const CAPTURED: Captured[] = [
  {
    icon: Lightbulb,
    kind: 'Decision',
    text: 'Revenue brief ships Mondays 9am to #leadership',
  },
  {
    icon: TriangleAlert,
    kind: 'Blocker',
    text: 'HubSpot deal-stage mapping needs finance sign-off',
  },
  {
    icon: Repeat,
    kind: 'Workflow',
    text: 'Month-end recon runs the board-update skill',
  },
];

const CARRIES: { icon: ComponentType<{ className?: string }>; label: string }[] = [
  { icon: Users, label: 'marko · Dom' },
  { icon: FileText, label: 'Q3 board deck' },
  { icon: FolderGit2, label: 'acme-ops' },
];

export function Step6OwnCli() {
  const reduced = useReducedMotion();
  const enter = (i: number) =>
    reduced
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { delay: 0.05 + i * 0.06, duration: 0.32, ease: 'easeOut' as const },
        };

  return (
    <div className="relative aspect-19/22 w-full overflow-visible">
      <WebPanelWrapper activeTab="memory">
        <div className="flex h-full flex-col">
          <PageHead
            title="Memory"
            sub="Context Kortix learned from your tools, files, and past sessions"
          />

          <Panel title="Captured this week" count="from real work">
            <div className="divide-border divide-y">
              {CAPTURED.map((item, i) => (
                <motion.div
                  key={item.text}
                  {...enter(i)}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <span className="border-border bg-background text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md border">
                    <item.icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                      {item.kind}
                    </div>
                    <div className="text-foreground mt-0.5 text-sm leading-snug">{item.text}</div>
                  </div>
                </motion.div>
              ))}
            </div>
          </Panel>

          <motion.div {...enter(CAPTURED.length)} className="mt-4">
            <div className="text-muted-foreground mb-2 text-xs font-medium">Carries forward</div>
            <div className="flex flex-wrap gap-1.5">
              {CARRIES.map((chip) => (
                <Badge key={chip.label} size="sm" variant="outline" className="gap-1.5">
                  <chip.icon className="size-3.5" />
                  {chip.label}
                </Badge>
              ))}
            </div>
          </motion.div>

          <motion.p
            {...enter(CAPTURED.length + 1)}
            className={cn(
              'border-border/60 bg-muted/20 text-muted-foreground mt-4 rounded-md border px-3 py-2.5 text-xs leading-relaxed',
            )}
          >
            Reused across sessions — every coworker starts from what the team already knows.
          </motion.p>
        </div>
      </WebPanelWrapper>
    </div>
  );
}
