import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `ProjectOnboardingWizard` cannot be rendered here: `apps/web`'s `bun test`
 * runs WITHOUT `--isolate`, so `mock.module('@tanstack/react-query', …)` would
 * be process-wide and corrupt every other file in the run, and there is no
 * jsdom/`@testing-library/react` harness. Same split as
 * `settings-view.rename.test.tsx`: this pins the WIRING, and
 * `complete-then.test.ts` proves what the wired function DOES.
 */
const source = readFileSync(join(import.meta.dir, 'project-onboarding-wizard.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const shellSource = readFileSync(
  join(import.meta.dir, '../../features/workspace/project-layout/project-shell.tsx'),
  'utf8',
);

describe('ProjectOnboardingWizard: completion wiring', () => {
  test('the scan found the component', () => {
    // Guard the guard: an empty string passes every `.not.toContain` below.
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain('export function ProjectOnboardingWizard');
  });

  test('the single exit routes through completeThenNotify with onCompleted', () => {
    expect(code).toContain("import { completeThenNotify } from './onboarding/complete-then'");
    expect(code).toMatch(
      /completeThenNotify\(\s*\(\)\s*=>\s*onboarding\.complete\(\),\s*onCompleted,?\s*\)/,
    );
  });

  // The pre-change form. If this reappears, the stamp is being awaited without
  // the swallow and a failed PATCH can seal the user into the modal.
  test('the raw complete() is no longer the exit', () => {
    expect(code).not.toMatch(/const complete = useCallback\(\(\) => onboarding\.complete\(\)/);
  });

  test('skipSurvey is untouched — it is step navigation, not an exit', () => {
    expect(code).toContain('const skipSurvey = useCallback(');
    expect(code).not.toContain('completeThenNotify(skipSurvey');
  });
});

describe('ProjectOnboardingWizard: the skip control is opt-in', () => {
  test('the control renders only when onSkip is supplied', () => {
    expect(code).toContain('{onSkip && (');
    expect(code).toContain('Skip for now');
  });

  test('both new props are optional', () => {
    expect(code).toContain('onCompleted?: () => void');
    expect(code).toContain('onSkip?: () => void');
  });

  /**
   * THE no-regression assertion. The project shell must keep passing neither
   * prop, so its path stays exactly what shipped: no skip control, no
   * completion callback, wizard simply disappears in place. If someone wires
   * a prop here, the project-page behaviour changed without anyone deciding
   * that it should.
   */
  test('project-shell renders the wizard with projectId ONLY', () => {
    expect(shellSource.length).toBeGreaterThan(0);
    expect(shellSource).toContain('<ProjectOnboardingWizard projectId={projectId} />');
    expect(shellSource).not.toContain('onSkip');
    expect(shellSource).not.toContain('onCompleted');
  });
});
