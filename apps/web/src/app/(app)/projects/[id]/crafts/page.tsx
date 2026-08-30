import { CraftsStore } from '@/features/crafts/crafts-store';

export default async function ProjectCraftsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CraftsStore projectId={id} />;
}
