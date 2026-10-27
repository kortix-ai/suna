'use client';

import { useParams } from 'next/navigation';

import { ConnectorPage } from '@kortix/ui/customize/connectors/detail/connector-page';

import { decodeSegment, ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /projects/[id]/admin/connectors/<app>/<connector> — one connector, in the Connectors pane. */
export default function ProjectAdminConnectorPage() {
  const { id: projectId, app, connector } = useParams<{ id: string; app: string; connector: string }>();
  const connectorSlug = decodeSegment(connector);
  return (
    <ProjectAdminRoute
      projectId={projectId}
      section="connectors"
      content={
        <ConnectorPage
          key={connectorSlug}
          projectId={projectId}
          appSegment={decodeSegment(app)}
          connectorSlug={connectorSlug}
        />
      }
    />
  );
}
