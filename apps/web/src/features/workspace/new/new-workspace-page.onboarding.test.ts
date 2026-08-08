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
    // Guard the guard before slicing: `indexOf` returns -1 when the tag is
    // absent, and `code.slice(-1)` is a non-empty one-character string, so the
    // old length check passed even with the wizard deleted outright.
    expect(code).toContain('<ProjectOnboardingWizard');
    const wizardBlock = code.slice(code.indexOf('<ProjectOnboardingWizard'));
    expect(wizardBlock.length).toBeGreaterThan(0);
    expect(wizardBlock).toContain(
      'router.replace(`/projects/${encodeURIComponent(onboardingProjectId)}`)',
    );
    expect(wizardBlock).not.toContain('router.push(');
  });

  /**
   * `onboardingPath` percent-encodes on the way in, so the return trip must
   * too. Asymmetric encoding would build a broken URL for any id carrying a
   * character that is not URL-safe.
   */
  test('every trip into the workspace percent-encodes the id, matching onboardingPath', () => {
    expect(code).not.toContain('`/projects/${onboardingProjectId}`');
    expect(code.match(/\/projects\/\$\{encodeURIComponent\(onboardingProjectId\)\}/g)?.length).toBe(
      3,
    );
  });

  /**
   * `index`, `domain` and the survey `answers` are plain `useState` inside the
   * wizard, none keyed on the project. Without a key, a change of
   * `onboardingProjectId` on a mounted instance would PATCH workspace A's
   * answers onto workspace B.
   */
  test('the wizard is keyed on the project so state never crosses workspaces', () => {
    expect(code).toContain('key={onboardingProjectId}');
  });
});

/**
 * A reload of `/new?onboarding=<id>` starts the create hook at `status:
 * 'idle'`, so the page used to paint the live create FORM while
 * `getProjectDetail` was still in flight. The Name input carries `autoFocus`
 * and is fully interactive in that window: a user who reloads mid-onboarding
 * can start typing, and if `['accounts']` resolves first, Enter fires a SECOND
 * `runCreate`.
 */
describe('/new: the onboarding param owns the page', () => {
  test('neither the form nor ProvisionProgress renders while an onboarding project is in the URL', () => {
    expect(code).toContain('{!onboardingProjectId && (');
    expect(code).toContain('<AnimatePresence mode="wait" initial={false}>');
    const gated = code.slice(code.indexOf('{!onboardingProjectId && ('));
    expect(gated.indexOf('<AnimatePresence')).toBeGreaterThan(-1);
    // The gate must sit OUTSIDE the AnimatePresence, not inside one of its
    // branches — an inner guard still mounts the form's <input autoFocus>.
    expect(gated.indexOf('<AnimatePresence')).toBeLessThan(gated.indexOf('<form'));
  });

  /**
   * With the form gated off, a detail query still in flight (or errored) would
   * leave nothing on screen but the header. The workspace has already been
   * created and paid for, so there must always be a way into it.
   */
  test('an explicit way into the workspace is always on the page', () => {
    expect(code).toContain("import Loading from '@/components/ui/loading'");
    expect(code).toContain("import Link from 'next/link'");
    expect(code).toContain('href={`/projects/${encodeURIComponent(onboardingProjectId)}`}');
    expect(code).toContain('Go to workspace');
  });

  /**
   * `showUpgradeOption` is `isBillingEnabled()` — it tracks whether billing is
   * ON, not whether a `GlobalUpgradeModal` is MOUNTED. `AppProviders` (the only
   * other host) is mounted by `project-shell.tsx` and the share page, never by
   * `app/(app)/layout.tsx`, so on `/new` billing can be enabled with no host at
   * all and the plan step's "See plans" stays a dead click.
   */
  test('/new hosts a GlobalUpgradeModal so the plan step has something to open', () => {
    expect(code).toContain(
      "import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal'",
    );
    expect(code).toContain("import { isBillingEnabled } from '@/lib/config'");
    expect(code).toContain('{isBillingEnabled() && <GlobalUpgradeModal />}');
  });
});
