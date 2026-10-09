import { FilesView } from '@/features/drives/files-view';

export default async function ProjectFilesDrivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FilesView projectId={id} />;
}
