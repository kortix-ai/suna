import { BackendDetailView } from '@/features/backends/backend-detail-view';

export default async function ProjectBackendPage({
  params,
}: {
  params: Promise<{ id: string; backendId: string }>;
}) {
  const { id, backendId } = await params;
  return <BackendDetailView projectId={id} backendId={backendId} />;
}
