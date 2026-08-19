import { AppsView } from '@/features/apps/apps-view';

export default async function ProjectAppsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppsView projectId={id} />;
}
