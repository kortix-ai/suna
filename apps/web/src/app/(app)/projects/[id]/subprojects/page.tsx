import { SubprojectsStore } from '@/features/subprojects/subprojects-store';

export default async function ProjectSubprojectsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SubprojectsStore projectId={id} />;
}
