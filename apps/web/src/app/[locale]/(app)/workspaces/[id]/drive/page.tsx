'use client';

import { notFound, useParams } from 'next/navigation';

import { FilesView } from '@/features/drives/files-view';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * /projects/[id]/drive — the project's Drive: every member's own folder and
 * the shared drives, a top-level page beside Sessions. It exists only with
 * Volumes on (the project's derived `drives` flag); off, it is not found and
 * the sidebar's Files row is the repo browser, as before volumes.
 */
export default function ProjectDrivePage() {
  const { id } = useParams<{ id: string }>();
  const volumes = useFeatureFlag(id, 'drives');

  if (!volumes.isLoading && !volumes.enabled) notFound();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <FilesView projectId={id} />
    </div>
  );
}
