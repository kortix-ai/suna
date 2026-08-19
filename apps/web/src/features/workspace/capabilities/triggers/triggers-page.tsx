'use client';

import { ScheduleView } from '@/components/projects/schedule-view';

/**
 * The page body for /projects/[id]/triggers — the capability tab that
 * graduated out of the Settings overlay. A trigger is one resource with two
 * ways to start it (schedule or webhook), so this mounts one `ScheduleView`
 * listing both, not two kind-locked pages.
 *
 * No chrome of its own. `ScheduleView` renders `CapabilityPageShell` — the
 * same shell Connectors, Agents and Skills use — so Triggers is the same
 * `max-w-5xl` column with the same heading and header group as its three
 * sibling tabs. That shell is also the route's scroll container
 * (`min-h-0 flex-1 overflow-y-auto`), which the `(capabilities)` layout
 * requires: it is a bounded `h-svh` column, and something inside it has to
 * scroll or the tab bar above scrolls away with the content.
 *
 * This wrapper used to bring its own scroll box and `ScheduleView` its own
 * `max-w-2xl` heading — which is exactly what made this tab read as a
 * different product from the three beside it.
 */
export function TriggersPage({ projectId }: { projectId: string }) {
  return <ScheduleView projectId={projectId} />;
}
