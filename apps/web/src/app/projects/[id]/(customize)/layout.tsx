'use client';

/**
 * Customize layout — wraps every per-project config surface (agents,
 * skills, secrets, triggers, channels, executor, settings) in a
 * shared shell.
 *
 * Owns two pieces of chrome so the section pages stay focused on their
 * own body:
 *   1. <ProjectShell>           — outer project sidebar + tab bar
 *   2. <CustomizeNav>           — secondary left-rail listing every
 *                                  config section, Vercel-settings style
 *
 * Section pages render the title bar + body to the right of the
 * secondary nav.
 */

import { useParams } from 'next/navigation';

import { CustomizeNav } from '@/components/projects/customize-nav';
import { ProjectShell } from '@/components/projects/project-shell';

interface CustomizeLayoutProps {
  children: React.ReactNode;
}

export default function CustomizeLayout({ children }: CustomizeLayoutProps) {
  // useParams reads from the active route directly — no Promise to unwrap,
  // so the layout stays stable across same-group navigations (agents → skills
  // → commands). The earlier `use(params)` setup re-suspended on every nav
  // and could make clicks feel like no-ops.
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';

  return (
    <ProjectShell projectId={projectId}>
      <div className="flex h-full min-h-0">
        <CustomizeNav projectId={projectId} />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </ProjectShell>
  );
}
