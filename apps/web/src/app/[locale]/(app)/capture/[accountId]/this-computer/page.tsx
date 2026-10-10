import { ThisComputerView } from '@/features/capture/this-computer/this-computer-view';

import { captureMetadata } from '../capture-metadata';

export const generateMetadata = () => captureMetadata('thisComputer');

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const p = await params;
  return <ThisComputerView accountId={p.accountId} />;
}
