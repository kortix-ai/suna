'use client';

import { ProjectShell } from '@/components/project-shell';
import { ProjectHome } from '@kortix/ui/workspace';
import { useParams } from 'next/navigation';

/**
 * The project home is Kortix's: the composer with the agent, model and
 * sandbox pickers. A send creates the session with the prompt and opens it
 * (`useProjectHomeSend` inside `ProjectHome`).
 */
export default function ProjectPage() {
  const params = useParams();
  return (
    <ProjectShell pageHasSidebarOpener>
      <ProjectHome projectId={String(params.id)} />
    </ProjectShell>
  );
}
