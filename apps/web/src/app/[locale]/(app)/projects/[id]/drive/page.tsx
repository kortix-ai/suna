import { DriveView } from '@/features/drives/drive-view';

export default async function ProjectDrivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DriveView projectId={id} />;
}
