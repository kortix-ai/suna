/**
 * `/projects/[id]/sessions` — every session of the project, opened from the
 * drawer. The project stack (ProjectScreen) registers this route and provides
 * the project through ProjectRouteProvider. See ProjectSessionsPage.
 */
import { useLocalSearchParams } from 'expo-router';
import { ProjectSessionsPage } from '@/components/session/ProjectSessionsPage';

export default function ProjectSessionsScreen() {
  // The drawer's Search row navigates here with `autoFocusSearch=1`.
  const { autoFocusSearch } = useLocalSearchParams<{ autoFocusSearch?: string }>();
  return <ProjectSessionsPage autoFocusSearch={autoFocusSearch === '1'} />;
}
