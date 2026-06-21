import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SessionStreamKeeper } from '@/components/projects/session-stream-keeper';
import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
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
      <SessionStreamKeeper projectId={projectId} />
      {children}
    </ProjectAccessBoundary>
  );
}
