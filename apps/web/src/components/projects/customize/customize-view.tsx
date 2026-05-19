'use client';

/**
 * Project Customize — single-page view.
 *
 * One umbrella surface that hosts every per-project config: Files, Skills,
 * Agents, Commands, Secrets, Schedules, Webhooks, Channels, Settings. Lives
 * at `/projects/[id]/customize?section=<name>` and renders inside the same
 * `ProjectShell` as sessions so the project sidebar + tab bar stay anchored
 * while a user is configuring the project.
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Customize                                                │
 *   ├─────────┬───────────────────────────────────────────────┤
 *   │ Files   │                                               │
 *   │ Skills  │  active section content                       │
 *   │ Agents  │  (each section owns its own internal          │
 *   │ ...     │   list + detail layout)                       │
 *   │ Settings│                                               │
 *   └─────────┴───────────────────────────────────────────────┘
 */

import { AgentsView } from '@/app/projects/[id]/(customize)/agents/page';
import { ChannelsView } from '@/app/projects/[id]/(customize)/channels/page';
import { CommandsView } from '@/app/projects/[id]/(customize)/commands/page';
import { SecretsView } from '@/app/projects/[id]/(customize)/secrets/page';
import { SettingsView } from '@/app/projects/[id]/(customize)/settings/page';
import { SkillsView } from '@/app/projects/[id]/(customize)/skills/page';
import { TriggersView } from '@/components/projects/triggers-view';
import type { CustomizeSection } from '@/lib/customize-sections';

import { CustomizeRail } from './customize-rail';
import { FilesSection } from './sections/files-section';

interface CustomizeViewProps {
  projectId: string;
  section: CustomizeSection;
}

export function CustomizeView({ projectId, section }: CustomizeViewProps) {
  return (
    <div className="flex h-full min-h-0">
      <CustomizeRail projectId={projectId} />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <SectionContent section={section} projectId={projectId} />
      </main>
    </div>
  );
}

function SectionContent({
  section,
  projectId,
}: {
  section: CustomizeSection;
  projectId: string;
}) {
  // Each branch is a separate component instance, so switching sections
  // tears down the previous tree. Matches the per-route behavior the
  // legacy (customize) layout had.
  switch (section) {
    case 'files':
      return <FilesSection projectId={projectId} />;
    case 'skills':
      return <SkillsView projectId={projectId} />;
    case 'agents':
      return <AgentsView projectId={projectId} />;
    case 'commands':
      return <CommandsView projectId={projectId} />;
    case 'secrets':
      return <SecretsView projectId={projectId} />;
    case 'schedules':
      return <TriggersView projectId={projectId} type="cron" />;
    case 'webhooks':
      return <TriggersView projectId={projectId} type="webhook" />;
    case 'channels':
      return <ChannelsView />;
    case 'settings':
      return <SettingsView projectId={projectId} />;
    default:
      return null;
  }
}
