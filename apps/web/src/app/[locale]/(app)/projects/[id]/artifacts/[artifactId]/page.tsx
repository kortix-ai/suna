'use client';

import { useParams } from 'next/navigation';

import { ArtifactViewer } from '@/features/artifacts/artifact-viewer';

/** /projects/[id]/artifacts/[artifactId] — one artifact (the layout gates the flag). */
export default function ProjectArtifactPage() {
  const { id, artifactId } = useParams<{ id: string; artifactId: string }>();
  return <ArtifactViewer key={artifactId} projectId={id} artifactId={artifactId} />;
}
