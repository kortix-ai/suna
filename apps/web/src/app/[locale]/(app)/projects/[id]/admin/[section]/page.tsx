'use client';

import { useParams } from 'next/navigation';

import { ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /projects/[id]/admin/<section> — one library or setting of Project admin. */
export default function ProjectAdminSectionPage() {
  const { id, section } = useParams<{ id: string; section: string }>();
  return <ProjectAdminRoute projectId={id} section={section} />;
}
