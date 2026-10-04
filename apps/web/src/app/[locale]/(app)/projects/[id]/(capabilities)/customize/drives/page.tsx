'use client';

import { useParams } from 'next/navigation';

import { DrivesCapabilityPage } from '@/features/workspace/capabilities/drives/drives-page';

/**
 * /projects/[id]/customize/drives — which drives this project's sessions and
 * agents may use. See `features/workspace/capabilities/drives/drives-page.tsx`.
 */
export default function ProjectDrivesPage() {
  const { id: projectId } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DrivesCapabilityPage projectId={projectId} />
    </div>
  );
}
