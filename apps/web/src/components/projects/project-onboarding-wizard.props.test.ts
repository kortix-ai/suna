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

/**
 * THE skip contract. Skipping STAMPS `metadata.onboarding_completed_at`,
 * exactly like finishing.
 *
 * It used to leave the project unstamped, on the theory that the project
 * shell's own copy of this wizard would catch the user on a later visit. That
 * premise is false: `/new`'s wizard has already warmed the SAME
 * `qk.project.detail(id)` entry the shell reads, so on arrival at
 * `/projects/<id>` the shell's copy sees `hydrated: true, status: 'pending'`
 * and opens IMMEDIATELY — with no `onSkip`, `showCloseButton={false}`,
 * `closeOnOutsideClick={false}` and Escape intercepted. Skipping was strictly
 * worse than not skipping.
 */
describe('ProjectOnboardingWizard: skipping stamps, exactly like finishing', () => {
  test('skip routes through the same completeThenNotify path as finishing', () => {
    expect(code).toMatch(
      /const skip = useCallback\(\s*\(\)\s*=>\s*completeThenNotify\(\(\)\s*=>\s*onboarding\.complete\(\),\s*onSkip\),/,
    );
  });

  test('the skip control fires the stamping path, never the raw prop', () => {
    // Guard the guard before slicing: `indexOf` returns -1 when the marker is
    // absent, and `slice(-1)` is a non-empty one-character string that would
    // pass every assertion below.
    expect(code).toContain('{onSkip && (');
    const skipBlock = code.slice(code.indexOf('{onSkip && ('));
    expect(skipBlock).toContain('onClick={skip}');
    expect(code).not.toContain('onClick={onSkip}');
  });

  // Both exits stamp, so both must go through the swallow in
  // `completeThenNotify` — a failed PATCH must never seal the user into a
  // modal that has no close button.
  test('both exits are wrapped — neither calls onboarding.complete() bare', () => {
    expect(code.match(/completeThenNotify\(/g)?.length).toBe(2);
    expect(code).not.toMatch(/const skip = useCallback\(\(\) => onboarding\.complete\(\)/);
  });
});

/**
 * The chrome bar used to centre `StepProgress` with `absolute inset-x-0` at a
 * fixed 200px. On a 375px screen that ran x≈87→287 while "Skip for now" started
 * at x≈264 — ~23px of overlap, ~51px at 320px. Because the overlay carried
 * `pointer-events-none` the button still worked, so it failed silently as a
 * visual collision that no functional test could see. These pin the flow layout
 * that makes the overlap unrepresentable.
 */
describe('wizard chrome: the skip control is mobile-safe', () => {
  const chromeStart = code.indexOf('grid h-14');
  const chrome = chromeStart < 0 ? '' : code.slice(chromeStart, code.indexOf('</div>', chromeStart));

  test('the scan found the chrome bar', () => {
    // Guard the guard: an empty slice passes every `.not.toContain` below.
    expect(chromeStart).toBeGreaterThan(-1);
    expect(chrome.length).toBeGreaterThan(0);
  });

  test('the bar is a grid, and the progress is NOT an absolute overlay', () => {
    expect(chrome).toContain('grid-cols-[1fr_auto_1fr]');
    // The exact pre-fix construct. If it returns, so does the overlap.
    expect(code).not.toContain('pointer-events-none absolute inset-x-0');
    expect(code).not.toContain('ml-auto');
  });

  test('the skip control uses the responsive size, not the desktop-only one', () => {
    const skipBlock = code.slice(code.indexOf('{onSkip && ('));
    expect(skipBlock.length).toBeGreaterThan(0);
    // `magic-sm` is h-9 on touch, h-8 from `sm`. Plain `sm` would give a 32px
    // tap target on a phone.
    expect(skipBlock).toContain('size="magic-sm"');
    expect(skipBlock).not.toContain('size="sm"');
  });

  test('the label shortens on mobile but assistive tech keeps the full phrase', () => {
    const skipBlock = code.slice(code.indexOf('{onSkip && ('));
    expect(skipBlock).toContain('aria-label="Skip for now"');
    expect(skipBlock).toContain('<span className="sm:hidden">Skip</span>');
    expect(skipBlock).toContain('<span className="hidden sm:inline">Skip for now</span>');
  });

  test('the progress bar itself narrows on mobile', () => {
    const shell = readFileSync(join(import.meta.dir, 'onboarding/step-shell.tsx'), 'utf8');
    expect(shell).toContain('w-[7.5rem]');
    expect(shell).toContain('sm:w-[200px]');
    // The fixed width that could not shrink out of the side tracks' way.
    expect(shell).not.toContain('flex w-[200px] items-center');
  });
});
