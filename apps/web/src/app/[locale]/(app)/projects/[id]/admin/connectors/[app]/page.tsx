'use client';

import { useParams } from 'next/navigation';

import { AppPage } from '@kortix/ui/customize/connectors/detail/app-page';

import { decodeSegment, ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /projects/[id]/admin/connectors/<app> — one app's connectors, in the Connectors pane. */
export default function ProjectAdminConnectorAppPage() {
  const { id: projectId, app } = useParams<{ id: string; app: string }>();
  const appSegment = decodeSegment(app);
  return (
    <ProjectAdminRoute
      projectId={projectId}
      section="connectors"
      content={<AppPage key={appSegment} projectId={projectId} appSegment={appSegment} />}
    />
  );
}
