import { WorkflowsView } from '@/features/capture/workflows/workflows-view';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('workflows');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return <WorkflowsView accountId={accountId} />;
}
