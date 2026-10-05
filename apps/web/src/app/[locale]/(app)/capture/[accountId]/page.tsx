import { OverviewView } from '@/features/capture/overview/overview-view';

import { captureMetadata } from './capture-metadata';

export const generateMetadata = () => captureMetadata('overview');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const p = await params;
  return <OverviewView accountId={p.accountId} />;
}
