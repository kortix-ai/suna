'use client';

/**
 * Section previews for the logged-out homepage.
 *
 * Clicking Connectors / Skills / Automations / Agents before signing in shows
 * the real screen — the same ProjectSectionPage, the same title, description,
 * filter pills and search — with every action routed to sign-in. You can see
 * what each surface is before committing to an account.
 *
 * Automations renders the ACTUAL view: its query is guarded on `!!projectId`,
 * so with none it paints its own empty state.
 *
 * Connectors renders a real, browsable catalogue — see demo/connectors-demo.tsx
 * for why it reads a curated static list instead of fetching (both catalogue
 * endpoints are project-scoped and 401 without a session), and how every entry
 * in that list is checked against the repo.
 *
 * Skills and Agents still wrap large legacy views with unguarded queries, so
 * they render the shared page shell directly rather than fetching. As each
 * screen migrates to ProjectSectionPage it should be swapped in here the same
 * way.
 */

import { SparklesSolid } from '@mynaui/icons-react';
import { Bot, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConnectorsDemo } from '@/features/home/demo/connectors-demo';
import { useSignInGate } from '@/features/home/use-sign-in-gate';
import { AutomationsView } from '@/features/workspace/automations/automations-view';
import { ProjectSectionPage } from '@/features/workspace/project-section/project-section-page';
import type { ProjectNavKey } from '@/lib/project-nav';

interface PreviewCopy {
  title: string;
  description: string;
  actionLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  icon: typeof Bot;
}

const COPY: Record<Exclude<ProjectNavKey, 'automations' | 'connectors'>, PreviewCopy> = {
  skills: {
    title: 'Skills',
    description: 'Reusable capabilities your agent applies on its own.',
    actionLabel: 'New skill',
    emptyTitle: 'Teach it how you work',
    emptyDescription:
      'Write a workflow down once and every session reuses it, instead of re-explaining it each time.',
    icon: SparklesSolid as unknown as typeof Bot,
  },
  agents: {
    title: 'Agents',
    description: 'Shape how each agent thinks, and what it can reach.',
    actionLabel: 'New agent',
    emptyTitle: 'Give the work an owner',
    emptyDescription:
      'Each agent is a file in your repo, with its own instructions, model and scoped access.',
    icon: Bot,
  },
};

export function AnonymousSectionPreview({ section }: { section: ProjectNavKey }) {
  const { gate } = useSignInGate();

  // The real screen: guarded query, so it paints its own empty state.
  if (section === 'automations') {
    return <AutomationsView projectId="" />;
  }

  // The real screen over a curated, verified list — see demo/connectors-demo.tsx.
  if (section === 'connectors') {
    return <ConnectorsDemo />;
  }

  const copy = COPY[section];

  return (
    <ProjectSectionPage
      title={copy.title}
      description={copy.description}
      search={{
        value: '',
        onChange: () => gate('/'),
        placeholder: `Search ${copy.title.toLowerCase()}`,
      }}
      action={
        <Button type="button" size="sm" onClick={() => gate('/')}>
          <Plus className="size-4" />
          {copy.actionLabel}
        </Button>
      }
      state="empty"
      emptyProps={{
        icon: copy.icon,
        title: copy.emptyTitle,
        description: copy.emptyDescription,
        action: (
          <Button type="button" size="sm" onClick={() => gate('/')}>
            Sign in to start
          </Button>
        ),
      }}
    />
  );
}

export default AnonymousSectionPreview;
