import { TriggerRunsPage } from '@/features/workspace/capabilities/monitoring/trigger-runs-page';

/**
 * /projects/[id]/monitoring/runs — the Trigger runs tab. The tab bar lives in
 * `../layout.tsx`; this page is only the scroller under it.
 */
export default async function ProjectMonitoringRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TriggerRunsPage projectId={id} />;
}
