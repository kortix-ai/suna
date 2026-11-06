'use client';

import { useParams } from 'next/navigation';

import { ArtifactsGallery } from '@/features/artifacts/artifacts-gallery';

/** /projects/[id]/artifacts — the gallery (the layout gates the flag). */
export default function ProjectArtifactsPage() {
  const { id } = useParams<{ id: string }>();
  return <ArtifactsGallery projectId={id} />;
}
