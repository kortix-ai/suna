'use client';

import { useParams } from 'next/navigation';

import { AppsView } from '@/features/apps/apps-view';

/** /projects/[id]/customize/apps — the Apps tab. Shown in the bar only while the `apps` flag is on. */
export default function ProjectAppsPage() {
  const { id: projectId } = useParams<{ id: string }>();
  return <AppsView projectId={projectId} />;
}
