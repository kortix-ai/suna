'use client';

import { ProjectShell } from '@/components/project-shell';
import { ProjectUsage } from '@/components/usage/project-usage';
import { useParams } from 'next/navigation';

export default function ProjectUsagePage() {
  const projectId = String(useParams().id);
  return (
    <ProjectShell>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <ProjectUsage projectId={projectId} />
        </div>
      </div>
    </ProjectShell>
  );
}
