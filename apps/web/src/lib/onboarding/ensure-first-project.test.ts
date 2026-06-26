import { describe, expect, test } from 'bun:test';

import {
  hasFirstProjectBootstrapSignal,
  shouldAutoCreateFirstProject,
} from './ensure-first-project';

describe('hasFirstProjectBootstrapSignal', () => {
  test('recognizes explicit signup and subscription-return bootstrap signals', () => {
    expect(hasFirstProjectBootstrapSignal(new URLSearchParams('auth_event=signup'))).toBe(true);
    expect(hasFirstProjectBootstrapSignal(new URLSearchParams('team_signup=success'))).toBe(true);
  });

  test('ignores ordinary projects visits and non-signup auth events', () => {
    expect(hasFirstProjectBootstrapSignal(new URLSearchParams())).toBe(false);
    expect(hasFirstProjectBootstrapSignal(new URLSearchParams('auth_event=login'))).toBe(false);
  });
});

describe('shouldAutoCreateFirstProject', () => {
  test('allows the post-subscription onboarding return to bootstrap the first project', () => {
    expect(
      shouldAutoCreateFirstProject({
        bootstrapRequested: true,
        activeAccountId: 'acct_123',
        canCreateProjects: true,
        autoCreateAttempted: false,
        accountsLoading: false,
        projectsLoading: false,
        projectsError: false,
        projectsLoaded: true,
        projectCount: 0,
        legacyMachinesLoaded: true,
        legacyMachineCount: 0,
        billingEnabled: true,
        accountStateLoading: false,
        canRun: true,
      }),
    ).toBe(true);
  });

  test('does not recreate a project when a normal projects visit becomes empty after deletion', () => {
    expect(
      shouldAutoCreateFirstProject({
        bootstrapRequested: false,
        activeAccountId: 'acct_123',
        canCreateProjects: true,
        autoCreateAttempted: false,
        accountsLoading: false,
        projectsLoading: false,
        projectsError: false,
        projectsLoaded: true,
        projectCount: 0,
        legacyMachinesLoaded: true,
        legacyMachineCount: 0,
        billingEnabled: true,
        accountStateLoading: false,
        canRun: true,
      }),
    ).toBe(false);
  });
});
