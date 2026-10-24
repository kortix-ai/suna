'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

import { AgentPage } from '@kortix/ui/customize/agents/agent-page';

// Loaded when the Apps section opens: the Apps screen (grid, previews, the
// detail modal) is not part of the editor's first paint.
const AppsView = dynamic(() => import('@/features/apps/apps-view').then((m) => m.AppsView), {
  ssr: false,
});

/**
 * /projects/[id]/agent/[name] — one agent, as a page. The Agents tab opened on
 * a single agent: its instructions, model, triggers, grants, and who may use
 * it. See `packages/ui/src/customize/agents/agent-page.tsx`.
 *
 * `name` is the manifest key, URL-encoded by `agentHref` — decoded here once
 * so the page and every hook under it work with the real name.
 */
export default function ProjectAgentDetailPage() {
  const { id: projectId, name } = useParams<{ id: string; name: string }>();
  let agentName = name;
  try {
    agentName = decodeURIComponent(name);
  } catch {
    // A malformed escape in a hand-typed URL: use the raw segment and let the
    // page's not-found state say the agent does not exist.
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <AgentPage
        key={agentName}
        projectId={projectId}
        agentName={agentName}
        // The Apps screen lives in this app, so the page takes it as a slot.
        renderApps={({ agentName: name, grant }) => (
          <AppsView projectId={projectId} surface={{ kind: 'agent', agentName: name }} grant={grant} />
        )}
      />
    </div>
  );
}
