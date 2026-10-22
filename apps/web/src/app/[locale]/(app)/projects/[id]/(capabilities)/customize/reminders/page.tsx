import { ProjectRemindersView } from '@/features/workspace/project-reminders/project-reminders-view';

/**
 * /projects/[id]/customize/reminders — every scheduled check-in on the
 * project's sessions, a Customize tab (`remindersHref`). The tab bar and its
 * access rule come from the `(capabilities)` layout: only a caller who can
 * configure triggers, in a project with the `reminders` flag on, reaches it.
 */
export default async function ProjectRemindersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectRemindersView projectId={id} />;
}
