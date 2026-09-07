'use client';

import { SpacePage } from '@/features/spaces/space-page';
import { useParams } from 'next/navigation';

export default function ProjectSpacePage() {
  const { id: projectId, slug } = useParams<{ id: string; slug: string }>();

  return <SpacePage projectId={projectId} slug={slug} />;
}
