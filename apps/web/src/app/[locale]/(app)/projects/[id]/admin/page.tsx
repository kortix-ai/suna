'use client';

import { useParams } from 'next/navigation';

import { ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/**
 * /projects/[id]/admin — Project admin on the first section the caller may
 * open. Every project-wide library and setting has one home here,
 * `/projects/[id]/admin/<section>`; Customize keeps Agents and Review.
 */
export default function ProjectAdminPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectAdminRoute projectId={id} />;
}
