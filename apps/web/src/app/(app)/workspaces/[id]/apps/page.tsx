import { AppsView } from '@/features/apps/apps-view';

export default async function WorkspaceAppsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppsView workspaceId={id} />;
}
