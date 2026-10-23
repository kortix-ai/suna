'use client';

import { useParams } from 'next/navigation';

import { ProjectAdminHub } from '@kortix/ui/customize/admin/project-admin-hub';

/**
 * /projects/[id]/admin — the per-project admin environment: the project's
 * backend configuration grouped and separated from day-to-day usage. See
 * `packages/ui/src/customize/admin/project-admin-hub.tsx` for the body.
 */
export default function ProjectAdminPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectAdminHub projectId={projectId} />
    </div>
  );
}
