import { StageBoardPage } from '@/features/workspace/capabilities/monitoring/stage-board-page';

/**
 * /projects/[id]/monitoring — the stage board, the landing Monitoring tab.
 * A top-level project route like `/apps`, not a Customize tab: the Customize
 * bar is gated on `project.customize.read` (manager-tier), and this page is
 * for everyone who can run a session. Flag-gated on `monitoring` inside. The
 * tab bar lives in `./layout.tsx`.
 */
export default async function ProjectMonitoringPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <StageBoardPage projectId={id} />;
}
