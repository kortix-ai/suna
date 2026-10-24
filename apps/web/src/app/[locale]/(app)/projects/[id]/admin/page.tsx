'use client';

import { useParams } from 'next/navigation';

import { ProjectAdminDashboard } from '@kortix/ui/workspace';

/**
 * /projects/[id]/admin — the project's wp-admin-style overview. A read-only
 * inventory of every resource an agent can be granted (agents, skills,
 * connectors, triggers, reminders, models, secrets, review), each linking to
 * the capability page that owns its editing. Gated on `project.settings.write`
 * inside the dashboard.
 */
export default function ProjectAdminPage() {
  const { id } = useParams<{ id: string }>();
  return <ProjectAdminDashboard projectId={id} />;
}
