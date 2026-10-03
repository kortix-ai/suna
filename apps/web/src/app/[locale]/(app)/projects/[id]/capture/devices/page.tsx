import { DevicesView } from '@/features/capture/devices/devices-view';

export default async function CaptureDevicesViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DevicesView projectId={id} />;
}
