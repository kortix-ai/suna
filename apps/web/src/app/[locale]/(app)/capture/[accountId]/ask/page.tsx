import { AskView } from '@/features/capture/ask/ask-view';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('ask');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return <AskView accountId={accountId} />;
}
