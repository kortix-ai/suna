import { PeopleView } from '@/features/capture/people/people-view';

export default async function CapturePeopleViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PeopleView projectId={id} />;
}
