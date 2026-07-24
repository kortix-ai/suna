import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LlmCatalogBootstrap } from '@/components/projects/llm-catalog-bootstrap';
import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
import { SessionCacheWarmer } from '@/components/projects/session-cache-warmer';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';
import { createClient } from '@/lib/supabase/server';

interface ProjectLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/auth');

  void (await cookies());

  const { id: projectId } = await params;

  return (
    <ProjectAccessBoundary projectId={projectId}>
      <SessionCacheWarmer projectId={projectId} />
      <LlmCatalogBootstrap projectId={projectId} />
      <ProjectShell projectId={projectId}>{children}</ProjectShell>
    </ProjectAccessBoundary>
  );
}
