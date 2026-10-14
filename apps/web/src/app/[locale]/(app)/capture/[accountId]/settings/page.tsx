import { CaptureSettingsPage } from '@/features/capture/settings/settings-page';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('settings');

/** The organization's Kortix Capture settings: the on/off switch and the policy. */
export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return <CaptureSettingsPage accountId={accountId} />;
}
