'use client';

/**
 * Automations, signed out.
 *
 * The real screen already renders here — its query is guarded on `!!projectId`
 * — but what it renders with no project is an empty state, which tells a
 * visitor nothing about what an automation is. This shows the list instead,
 * over triggers that real Kortix project templates declare (see
 * demo-automations-data.ts).
 *
 * The cadence line is not written by hand: `describeCron` — the exact function
 * the signed-in screen uses — turns each manifest's cron expression into
 * "Mondays at 09:00". So the demo phrases a schedule the way the product does,
 * and keeps phrasing it that way when the product changes its mind.
 *
 * No run history and no on/off switch: those are per-account state, and a
 * "last run 2h ago" on a page with no account would be a lie.
 */

import { AlarmClockSolid } from '@mynaui/icons-react';
import { Webhook } from 'lucide-react';
import type { ReactNode } from 'react';

import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { describeCron } from '@/features/workspace/automations/cron';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';
import {
  ProjectSectionList,
  ProjectSectionRow,
} from '@/features/workspace/project-section/project-section-row';

import { DEMO_AUTOMATIONS, type DemoAutomation, WEBHOOK_CADENCE } from './demo-automations-data';
import { DemoAction, DemoPills, demoSearch } from './demo-controls';

/** Mirrors `cadenceOf` in automations-view.tsx, minus the one-off `run_at` case. */
function cadenceOf(automation: DemoAutomation): string {
  if (automation.type === 'webhook') return WEBHOOK_CADENCE;
  return automation.cron ? describeCron(automation.cron) : 'No schedule';
}

const PILLS = [
  { id: 'all', label: 'All' },
  { id: 'cron', label: 'Schedules' },
  { id: 'webhook', label: 'Webhooks' },
];

export function AutomationsDemo({ navTabs }: { navTabs?: ReactNode }) {
  const { gate } = useSignInGate();
  const onGate = () => gate('/');

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Automations"
      description="Run work on a schedule, or when something happens elsewhere."
      search={demoSearch('Search automations', onGate)}
      action={<DemoAction label="New automation" onGate={onGate} />}
      filters={<DemoPills options={PILLS} active="all" onGate={onGate} />}
      state="ready"
    >
      <ProjectSectionList>
        {DEMO_AUTOMATIONS.map((automation) => {
          const isWebhook = automation.type === 'webhook';
          const RowIcon = isWebhook ? Webhook : AlarmClockSolid;
          return (
            <ProjectSectionRow
              key={automation.slug}
              onClick={onGate}
              leading={<RowIcon className="text-muted-foreground size-4" />}
              title={automation.name}
              subtitle={cadenceOf(automation)}
            />
          );
        })}
      </ProjectSectionList>
    </ProjectSectionPage>
  );
}

export default AutomationsDemo;
