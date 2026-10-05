import { WorkflowDetailView } from '@/features/capture/workflows/workflow-detail-view';

import { captureMetadata } from '../../capture-metadata';

export const generateMetadata = () => captureMetadata('workflows');

export default async function Page({
  params,
}: {
  params: Promise<{ accountId: string; workflowId: string }>;
}) {
  const { accountId, workflowId } = await params;
  return <WorkflowDetailView accountId={accountId} workflowId={workflowId} />;
}
