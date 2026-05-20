'use client';

import { AgentsView } from '@/app/projects/[id]/(customize)/agents/page';
import { ChannelsView } from '@/app/projects/[id]/(customize)/channels/page';
import { CommandsView } from '@/app/projects/[id]/(customize)/commands/page';
import { SecretsView } from '@/app/projects/[id]/(customize)/secrets/page';
import { SettingsView } from '@/app/projects/[id]/(customize)/settings/page';
import { SkillsView } from '@/app/projects/[id]/(customize)/skills/page';
import { TriggersView } from '@/components/projects/triggers-view';
import type { CustomizeSection } from '@/lib/customize-sections';

import { FilesSection } from './sections/files-section';

interface CustomizeViewProps {
  projectId: string;
  section: CustomizeSection;
}

export function CustomizeView({ projectId, section }: CustomizeViewProps) {
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <SectionContent section={section} projectId={projectId} />
    </main>
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
