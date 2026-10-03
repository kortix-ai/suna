import { RangesView } from '@/features/capture/ranges/ranges-view';

export default async function CaptureRangesViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RangesView projectId={id} />;
}
