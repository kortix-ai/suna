import { ProjectScreenLegacy } from '@/components/session/ProjectScreenLegacy';
// NOTE: The redesigned ProjectScreen is intentionally NOT imported here yet.
// The project route renders the original screen verbatim so nothing regresses.
// When we resume the flag-guarded test-flip, re-add:
//   import { ProjectScreen } from '@/components/session/ProjectScreen';
// and gate it behind USE_NEW_PROJECT_UI.

export default function ProjectRoute() {
  return <ProjectScreenLegacy />;
}
