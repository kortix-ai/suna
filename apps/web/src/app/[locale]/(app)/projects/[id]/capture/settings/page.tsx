import { CaptureSettingsView } from '@/features/capture/settings/settings-view';

export default async function CaptureCaptureSettingsViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CaptureSettingsView projectId={id} />;
}
