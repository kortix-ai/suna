/**
 * The Triggers page's pause-all gear, rendered per role (KRTX-1720).
 *
 * `PATCH /projects/:id/triggers/activation` loads the project for write and
 * asserts `project.trigger.update`, so the gear shows only for a viewer who
 * holds both: the trigger controls' `canUpdate` from `@kortix/sdk`. It used to
 * read `effective_project_role === 'manager'`, a role label that a custom role
 * holding exactly those leaves could never satisfy. The permission probe is a
 * stub; the gear, the trigger controls and the SDK mapping are real.
 */
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let leaves: Record<string, { allowed: boolean }> = {};
const projectCan = await import('@/lib/use-project-can');
mock.module('@/lib/use-project-can', () => ({
  ...projectCan,
  useProjectCans: (_projectId: string, actions: readonly string[]) =>
    Object.fromEntries(actions.map((action) => [action, leaves[action] ?? { allowed: false }])),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { PROJECT_ACTIONS } = await import('@kortix/sdk');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { TriggerActivationMenu } = await import('./schedule-view');

const { PROJECT_WRITE, PROJECT_TRIGGER_CREATE, PROJECT_TRIGGER_FIRE, PROJECT_TRIGGER_UPDATE } =
  PROJECT_ACTIONS;
const grant = (...granted: string[]) =>
  Object.fromEntries(granted.map((leaf) => [leaf, { allowed: true }]));

function render(next: Record<string, { allowed: boolean }>): string {
  leaves = next;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <TriggerActivationMenu projectId="p1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the pause-all gear', () => {
  test('a role with project.write + project.trigger.update gets the gear', () => {
    expect(render(grant(PROJECT_WRITE, PROJECT_TRIGGER_UPDATE))).toContain('aria-label="More"');
  });

  test('project.trigger.update without project.write gets no gear: the route loads the project for write', () => {
    expect(render(grant(PROJECT_TRIGGER_UPDATE))).toBe('');
  });

  test('the create leaf does not open it: pausing is an update', () => {
    expect(render(grant(PROJECT_WRITE, PROJECT_TRIGGER_CREATE))).toBe('');
  });

  test('a built-in member, who fires triggers, gets no gear', () => {
    expect(render(grant(PROJECT_TRIGGER_FIRE))).toBe('');
  });

  test('an unresolved probe shows no gear (fail closed)', () => {
    expect(render({})).toBe('');
  });
});
