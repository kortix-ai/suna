'use client';

/**
 * Agents, signed out.
 *
 * The claim this screen has to make is what an agent actually IS: a markdown
 * file in your repo, with its own prompt, its own mode, and its own scoped
 * access. So it shows the two agent files every Kortix project is created with
 * — their real descriptions, their real modes, their real paths — instead of a
 * flattering invented roster (see demo-agents-data.ts).
 *
 * Two rows is the honest number. The signed-in screen is a master-detail split
 * whose detail pane needs the project config; a visitor gets the list half and
 * a gate on the way into the detail.
 */

import { StarSolid } from '@mynaui/icons-react';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { formatMode } from '@/features/workspace/customize/shared/utils';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';
import {
  ProjectSectionList,
  ProjectSectionRow,
} from '@/features/workspace/project-section/project-section-row';

import { DEMO_AGENTS } from './demo-agents-data';
import { DemoAction, demoSearch } from './demo-controls';

/** Same target as `AGENT_DOCS` in customize/sections/view/agents-view.tsx. */
const AGENT_DOCS = 'https://opencode.ai/docs/agents/';

export function AgentsDemo({ navTabs }: { navTabs?: ReactNode }) {
  const { gate } = useSignInGate();
  const onGate = () => gate('/');

  return (
    <ProjectSectionPage
      navTabs={navTabs}
      title="Agents"
      description="Reusable personas that run your sessions, each with its own prompt and model."
      docsHref={AGENT_DOCS}
      search={demoSearch('Search agents', onGate)}
      action={<DemoAction label="New agent" onGate={onGate} />}
      state="ready"
    >
      <ProjectSectionList>
        {DEMO_AGENTS.map((agent) => (
          <ProjectSectionRow
            key={agent.path}
            onClick={onGate}
            leading={<Bot className="text-muted-foreground size-4" />}
            title={agent.name}
            badges={
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge variant="muted" size="xs">
                  {formatMode(agent.mode)}
                </Badge>
                {agent.isDefault ? (
                  <StarSolid
                    aria-label="Project default"
                    className="text-kortix-orange size-4 shrink-0 fill-current"
                  />
                ) : null}
              </span>
            }
            subtitle={agent.description}
          />
        ))}
      </ProjectSectionList>
    </ProjectSectionPage>
  );
}

export default AgentsDemo;
