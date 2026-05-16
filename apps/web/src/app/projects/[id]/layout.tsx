import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

interface ProjectLayoutProps {
  children: React.ReactNode;
}

/**
 * Project layout: auth + sidebar-cookie passthrough only.
 *
 * The shell decision moved into each page so project sessions, files, and
 * settings can mount the repo-first `<ProjectShell />` without double-wrapping
 * or re-reading auth state in this layout.
 */
export default async function ProjectLayout({ children }: ProjectLayoutProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/auth');

  // Individual project pages pick their own shell. Keep this layout dumb so it
  // never short-circuits the rendering tree.
  void (await cookies());

  return <>{children}</>;
}
