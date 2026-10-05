import { CaptureSettingsView } from '@/features/capture/settings/settings-view';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('settings');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const p = await params;
  return <CaptureSettingsView accountId={p.accountId} />;
}
