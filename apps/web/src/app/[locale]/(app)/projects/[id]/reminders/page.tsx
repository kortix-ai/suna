import { ProjectRemindersView } from '@/features/workspace/project-reminders/project-reminders-view';

export default async function ProjectRemindersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectRemindersView projectId={id} />;
}
