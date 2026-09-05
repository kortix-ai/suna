'use client';

import { SubprojectPage } from '@/features/subprojects/subproject-page';
import { useParams } from 'next/navigation';

export default function ProjectSubprojectPage() {
  const { id: projectId, slug } = useParams<{ id: string; slug: string }>();

  return <SubprojectPage projectId={projectId} slug={slug} />;
}
