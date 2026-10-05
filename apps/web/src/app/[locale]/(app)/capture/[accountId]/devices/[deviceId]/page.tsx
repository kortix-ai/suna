import { DeviceTimelineView } from '@/features/capture/timeline/timeline-view';

import { captureMetadata } from '../../capture-metadata';

export const generateMetadata = () => captureMetadata('timeline');

export default async function Page({ params }: { params: Promise<{ accountId: string; deviceId: string }> }) {
  const p = await params;
  return <DeviceTimelineView accountId={p.accountId} deviceId={p.deviceId} />;
}
