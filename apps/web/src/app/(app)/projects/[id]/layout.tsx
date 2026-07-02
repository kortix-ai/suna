import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ProjectAccessBoundary } from '@/components/projects/project-access-boundary';
import { SessionStreamKeeper } from '@/components/projects/session-stream-keeper';
import { SandboxLoadingBoundary } from '@/features/session/sandbox-loading-boundary';
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
      {/* Contain the "sandbox is still loading" boot race here (web-side, so it
          hot-reloads reliably) — a stray getClient() during a session switch
          shows the loader + auto-retries instead of the full-page error route. */}
      <SandboxLoadingBoundary>
        <SessionStreamKeeper projectId={projectId} />
        {children}
      </SandboxLoadingBoundary>
    </ProjectAccessBoundary>
  );
}
