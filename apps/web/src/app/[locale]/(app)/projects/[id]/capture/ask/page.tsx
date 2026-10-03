import { AskView } from '@/features/capture/ask/ask-view';

export default async function CaptureAskViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AskView projectId={id} />;
}
