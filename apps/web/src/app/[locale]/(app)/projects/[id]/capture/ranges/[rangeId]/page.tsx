import { RangeView } from '@/features/capture/ranges/range-view';

export default async function CaptureRangePage({
  params,
}: {
  params: Promise<{ id: string; rangeId: string }>;
}) {
  const { id, rangeId } = await params;
  return <RangeView projectId={id} rangeId={rangeId} />;
}
