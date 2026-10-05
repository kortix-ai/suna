import { DevicesView } from '@/features/capture/devices/devices-view';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('devices');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const p = await params;
  return <DevicesView accountId={p.accountId} />;
}
