import type { Metadata } from 'next';

import { CaptureAreaShell } from '@/features/capture/area/capture-area-shell';

export const metadata: Metadata = {
  title: { absolute: 'Kortix Capture', template: '%s · Kortix Capture' },
  robots: { index: false, follow: false },
};

/**
 * /capture/[accountId] — Kortix Capture for one organization (Kortix account):
 * Overview, Workflows, Devices, a device's timeline, This computer and
 * Settings. Its own top bar; no project sidebar.
 */
export default async function CaptureLayout({
  params,
  children,
}: {
  params: Promise<{ accountId: string }>;
  children: React.ReactNode;
}) {
  const { accountId } = await params;
  return <CaptureAreaShell accountId={accountId}>{children}</CaptureAreaShell>;
}
