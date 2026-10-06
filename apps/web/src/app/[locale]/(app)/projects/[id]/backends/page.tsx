import { BackendsView } from '@/features/backends/backends-view';

export default async function ProjectBackendsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BackendsView projectId={id} />;
}
