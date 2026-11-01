'use client';

import { Suspense, type ReactNode } from 'react';

import { ConnectorsAppReturnBar } from '@kortix/ui/customize/connectors/connectors-app-return-bar';
import { CustomizeFrame } from '@kortix/ui/customize/shared/customize-tab-bar';
import {
  ProjectAdminDashboard,
  type ProjectAdminHostSections,
} from '@kortix/ui/workspace/admin/project-admin-dashboard';

/* Project admin sections whose page lives in this app, not in `@kortix/ui`.
   None today: the Loops page (and its calendar) was removed on 2026-10-28;
   loops are triggers on the package's Triggers page (`/admin/triggers`,
   `/admin/loops` resolves there). Apps is not one either: its page is the
   sidebar's Apps (`/projects/:id/apps`), and `/admin/apps` redirects there. */
const HOST_SECTIONS: ProjectAdminHostSections = {};

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
      {/* The Customize bar over Project admin too: one row of tabs for both trees. */}
      <CustomizeFrame projectId={projectId}>
        <ProjectAdminDashboard projectId={projectId} section={section} content={content} hostSections={HOST_SECTIONS} />
      </CustomizeFrame>
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
