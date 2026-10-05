import { ThisComputerPage } from '@/features/capture/desktop/capture-section';

/** Kortix Capture's "This computer" (desktop app): record this computer for the account. */
export default async function CaptureThisComputerRoute({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return <ThisComputerPage accountId={accountId} />;
}
