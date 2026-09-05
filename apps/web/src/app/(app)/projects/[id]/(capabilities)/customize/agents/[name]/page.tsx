'use client';

import { useParams } from 'next/navigation';

import { AgentPage } from '@/features/workspace/capabilities/agents/agent-page';

/**
 * /projects/[id]/agent/[name] — one agent, as a page. The Agents tab opened on
 * a single agent: its instructions, model, triggers, grants, and who may use
 * it. See `features/workspace/capabilities/agents/agent-page.tsx`.
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
      <AgentPage key={agentName} projectId={projectId} agentName={agentName} />
    </div>
  );
}
