import { CraftReportsView } from '@/features/crafts/craft-reports-view';

export default async function ProjectCraftReportsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CraftReportsView projectId={id} />;
}
