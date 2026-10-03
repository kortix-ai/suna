import { TimelineView } from '@/features/capture/timeline/timeline-view';

export default async function CaptureTimelineViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TimelineView projectId={id} />;
}
