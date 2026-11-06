'use client';

import { useParams } from 'next/navigation';

import { ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /projects/[id]/admin/connectors — the static `connectors/` folder owns this path, so it needs its own page. */
export default function ProjectAdminConnectorsPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectAdminRoute projectId={id} section="connectors" />;
}
