'use client';

import { lazy } from 'react';
import { useParams } from 'next/navigation';

import {
  ProjectAdminDashboard,
  type ProjectAdminHostSections,
} from '@kortix/ui/workspace/admin/project-admin-dashboard';

/* The two Project admin sections whose pages live in this app, not in
   `@kortix/ui`. Lazy, like every other section: only the open one loads. */
const HOST_SECTIONS: ProjectAdminHostSections = {
  loops: lazy(() =>
    import('@/features/workspace/project-reminders/project-reminders-view').then((m) => ({
      default: m.ProjectRemindersView,
    })),
  ),
  apps: lazy(() => import('@/features/apps/apps-view').then((m) => ({ default: m.AppsView }))),
};

/**
 * /projects/[id]/admin — Project admin: every project-wide library (the global
 * variant of Connectors, Skills, Triggers, Loops, Models, Secrets, Apps) and
 * every project setting, one section at a time (`?section=<key>`). Gated on
 * `project.settings.write` inside the dashboard.
 *
 * `h-svh` bounds the page so each section scrolls inside its own pane; see
 * the `(capabilities)` layout for why nothing above gives it a height.
 */
export default function ProjectAdminPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectAdminDashboard projectId={id} hostSections={HOST_SECTIONS} />
    </div>
  );
}
