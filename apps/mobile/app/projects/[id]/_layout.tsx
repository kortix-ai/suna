import type { ProjectScreen as ProjectScreenComponent } from '@/components/session/ProjectScreen';

/**
 * The project stack: home (index), the open page or thread (view), the
 * Sessions page (sessions), the Files page (files), the Account page
 * (account), and a sub-page pushed over the page it was opened from (page:
 * project Settings, Schedules, Secrets).
 */
export default function ProjectLayout() {
  // expo-router loads every layout module while it builds the route tree at
  // app start. Requiring ProjectScreen here defers its module graph to the
  // first render of a project. Metro's `require` is synchronous and cached.
  const { ProjectScreen } = require('@/components/session/ProjectScreen') as {
    ProjectScreen: typeof ProjectScreenComponent;
  };
  return <ProjectScreen />;
}
