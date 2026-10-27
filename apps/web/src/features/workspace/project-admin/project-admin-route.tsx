'use client';

import { lazy, Suspense, type ReactNode } from 'react';

import { ConnectorsAppReturnBar } from '@kortix/ui/customize/connectors/connectors-app-return-bar';
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
 * Every `/projects/[id]/admin/**` route: Project admin on one section, and
 * optionally a page below it (a connector) in that section's pane.
 *
 * `h-svh` bounds the page so each section scrolls inside its own pane; see
 * the `(capabilities)` layout for why nothing above gives it a height.
 */
export function ProjectAdminRoute({
  projectId,
  section,
  content,
}: {
  projectId: string;
  section?: string;
  content?: ReactNode;
}) {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectAdminDashboard projectId={projectId} section={section} content={content} hostSections={HOST_SECTIONS} />
      {section === 'connectors' ? (
        <Suspense fallback={null}>
          <ConnectorsAppReturnBar />
        </Suspense>
      ) : null}
    </div>
  );
}

/** A URL segment as typed; a malformed escape stays raw so the page can say it does not exist. */
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
