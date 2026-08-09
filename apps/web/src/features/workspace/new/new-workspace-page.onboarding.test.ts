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
    // Two here — the wizard's `onCompleted` and `onSkip`. The third exit, the
    // escape link, moved into `workspace-handoff.tsx` and encodes there.
    expect(code.match(/\/projects\/\$\{encodeURIComponent\(onboardingProjectId\)\}/g)?.length).toBe(
      2,
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
  test('the onboarding param forces the handoff branch, so the form never renders under it', () => {
    // ONE derived flag, not two conditions tested separately at the JSX — the
    // second shape can drift into a state that renders neither branch.
    expect(code).toContain('const handingOff = submitting || Boolean(onboardingProjectId);');
    expect(code).toContain('{handingOff ? (');
  });

  test('the form is the OTHER branch of that swap, so the two can never both mount', () => {
    // A reload of `/new?onboarding=<id>` restarts the create hook at
    // `status: 'idle'`, so `submitting` alone would paint the form — <input
    // autoFocus> and all — while `getProjectDetail` is still in flight.
    const swap = code.match(/\{handingOff \? \(([\s\S]*?)\) : \(([\s\S]*?)\)\}/);
    expect(swap).not.toBeNull();
    const [, handoffBranch, formBranch] = swap ?? [];
    expect(handoffBranch).toContain('<WorkspaceHandoff');
    expect(handoffBranch).not.toContain('<form');
    expect(formBranch).toContain('<form');
  });

  /**
   * With the form gated off, a detail query still in flight (or errored) would
   * leave nothing on screen. The workspace has already been created and paid
   * for, so there must always be a way into it — `WorkspaceHandoff` owns that
   * link now, which is why it takes the project id at all.
   */
  test('the handoff is handed the project id, so it can offer a way into the workspace', () => {
    expect(code).toContain('projectId={onboardingProjectId}');
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
