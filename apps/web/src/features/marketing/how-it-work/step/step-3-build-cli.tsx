'use client';

import { PageHead, Panel } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { HiMiniSparkles } from 'react-icons/hi2';
import { WebPanelWrapper } from '../web-panel-wrapper';

type Skill = {
  name: string;
  desc: string;
  agent: string;
  runs: number;
  featured?: boolean;
};

const SKILLS: Skill[] = [
  {
    name: 'board-update',
    desc: 'Posts the Monday revenue brief to #leadership',
    agent: 'ops-coworker',
    runs: 24,
    featured: true,
  },
  {
    name: 'deal-desk-recap',
    desc: 'Summarizes won and lost deals for the sales sync',
    agent: 'sales-coworker',
    runs: 12,
  },
  {
    name: 'incident-postmortem',
    desc: 'Drafts a postmortem from the incident channel',
    agent: 'sre-coworker',
    runs: 7,
  },
];

export function Step3BuildCli() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const reduced = useReducedMotion();
  const enter = (i: number) =>
    reduced
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { delay: 0.05 + i * 0.07, duration: 0.32, ease: 'easeOut' as const },
        };

  return (
    <div className="relative aspect-19/22 w-full overflow-visible">
      <WebPanelWrapper activeTab="skills">
        <div className="flex h-full flex-col">
          <PageHead
            title="Skills"
            sub={tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep3BuildCli09aaddc7')}
          />

          <Panel
            title={tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep3BuildCli697a0b1c')}
            count={`· ${SKILLS.length}`}
          >
            <div className="divide-border divide-y">
              {SKILLS.map((skill, i) => (
                <motion.div
                  key={skill.name}
                  {...enter(i)}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3',
                    skill.featured && 'bg-kortix-green/5',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-md border',
                      skill.featured
                        ? 'border-kortix-green/20 bg-kortix-green/10 text-kortix-green'
                        : 'border-border bg-background text-muted-foreground',
                    )}
                  >
                    <HiMiniSparkles className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate font-mono text-sm font-medium">
                        {skill.name}
                      </span>
                      {skill.featured && (
                        <Badge size="sm" variant="success">
                          new
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-snug">
                      {skill.desc}
                    </p>
                    <div className="text-muted-foreground/70 mt-1.5 flex items-center gap-2 text-xs">
                      <span className="truncate">{skill.agent}</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span className="shrink-0">{skill.runs} runs</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span className="shrink-0">reviewed</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </Panel>

          <motion.p
            {...enter(SKILLS.length)}
            className="border-border/60 bg-muted/20 text-muted-foreground mt-4 rounded-md border px-3 py-2.5 text-xs leading-relaxed"
          >
            {tI18nHardcoded.raw('autoFeaturesMarketingHowItWorkStepStep3BuildCli4a1811fb')}
          </motion.p>
        </div>
      </WebPanelWrapper>
    </div>
  );
}
