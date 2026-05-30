import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { SessionStreamKeeper } from '@/components/projects/session-stream-keeper';

interface ProjectLayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

/**
 * Project layout: auth + sidebar-cookie passthrough only.
 *
 * The shell decision moved into each page so project sessions, files, and
 * settings can mount the repo-first `<ProjectShell />` without double-wrapping
 * or re-reading auth state in this layout.
 *
 * This layout PERSISTS across all `/projects/[id]/*` navigations (Next.js
 * keeps the layout mounted while only the page swaps). That makes it the right
 * home for <SessionStreamKeeper />, which keeps a live SSE stream open for every
 * open session sandbox at once — so backgrounded sessions never stop and the
 * streams aren't torn down every time you switch sessions.
 */
export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/auth');

  // Individual project pages pick their own shell. Keep this layout dumb so it
  // never short-circuits the rendering tree.
  void (await cookies());

  const { id: projectId } = await params;

  return (
    <>
      <SessionStreamKeeper projectId={projectId} />
      {children}
    </>
  );
}
