import { MonitoringPage } from '@/features/workspace/capabilities/monitoring/monitoring-page';

/**
 * /projects/[id]/monitoring — the stage board + trigger runs. A top-level
 * project route like `/apps`, not a Customize tab: the Customize bar is
 * gated on `project.customize.read` (manager-tier), and this page is for
 * everyone who can run a session. Flag-gated on `monitoring` inside.
 */
export default async function ProjectMonitoringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MonitoringPage projectId={id} />;
}
