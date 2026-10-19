'use client';

import { useParams } from 'next/navigation';

import { ModelsPage } from '@kortix/ui/customize';

/**
 * /projects/[id]/models — the standalone Models page. See
 * `features/workspace/capabilities/models/models-page.tsx` for the page body.
 */
export default function ProjectModelsPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return <ModelsPage projectId={projectId} />;
}
