import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The page cannot be rendered here — `apps/web`'s `bun test` runs WITHOUT
 * `--isolate`, so mocking `next/navigation` or `@tanstack/react-query` would
 * be process-wide across the run. Source scan, same technique as the sibling
 * `clone-param.test.ts` integration block.
 */
const source = readFileSync(join(import.meta.dir, 'new-workspace-page.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('/new hosts the onboarding wizard', () => {
  test('the scan found the page', () => {
    expect(code.length).toBeGreaterThan(0);
    expect(code).toContain('export function NewWorkspacePage');
  });

  test('it reads the project id from the onboarding param', () => {
    expect(code).toContain(
      "import { readOnboardingParam } from '@/features/workspace/new/onboarding-param'",
    );
    expect(code).toContain('readOnboardingParam(');
  });

  // One useSearchParams call feeds BOTH params. A second call would be a
  // second subscription to the same source for no reason.
  test('it reuses the existing useSearchParams call', () => {
    expect(code.match(/useSearchParams\(\)/g)?.length).toBe(1);
  });

  test('the wizard is mounted only when the param is present', () => {
    expect(code).toContain('onboardingProjectId && (');
    expect(code).toContain('<ProjectOnboardingWizard');
    expect(code).toContain('projectId={onboardingProjectId}');
  });

  test('both handlers are wired', () => {
    expect(code).toContain('onCompleted=');
    expect(code).toContain('onSkip=');
  });

  /**
   * `replace`, not `push`. `/new?onboarding=<id>` is a state the user must not
   * be able to navigate back into: the workspace already exists, so going
   * "back" would re-offer onboarding for a workspace they just finished.
   */
  test('it leaves for the workspace with replace, never push', () => {
    const wizardBlock = code.slice(code.indexOf('<ProjectOnboardingWizard'));
    expect(wizardBlock.length).toBeGreaterThan(0);
    expect(wizardBlock).toContain('router.replace(`/projects/${onboardingProjectId}`)');
    expect(wizardBlock).not.toContain('router.push(');
  });
});
