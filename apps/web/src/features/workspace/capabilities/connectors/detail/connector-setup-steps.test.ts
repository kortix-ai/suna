import { describe, expect, test } from 'bun:test';

import { connectorSetupSteps } from './connector-setup-steps';

const base = {
  displayName: 'Figma',
  managed: false,
  requiresCredential: true,
  usesProjectAuthorization: false,
  credentialSet: false,
  hasStrategyConnection: false,
  toolCount: 54,
  failing: false,
};

describe('connectorSetupSteps — the "what now?" answer, from real state', () => {
  test('a user-scoped credential connector points each member at Accounts', () => {
    const steps = connectorSetupSteps(base);
    expect(steps.map((step) => step.done)).toEqual([true, false, true]);
    expect(steps[1]?.title).toBe('Connect your account');
    expect(steps[1]?.hint).toContain('Accounts, below');
  });

  test('a project-scoped credential connector points at Connect above', () => {
    const steps = connectorSetupSteps({ ...base, usesProjectAuthorization: true });
    expect(steps[1]?.title).toBe('Add the credential');
    expect(steps[1]?.hint).toContain('Connect above');
    expect(steps[1]?.done).toBe(false);
    expect(
      connectorSetupSteps({ ...base, usesProjectAuthorization: true, credentialSet: true })[1]
        ?.done,
    ).toBe(true);
  });

  test('a managed connector says sign in, named after the app', () => {
    const steps = connectorSetupSteps({ ...base, managed: true });
    expect(steps[1]?.title).toBe('Sign in to Figma');
    expect(
      connectorSetupSteps({ ...base, managed: true, hasStrategyConnection: true })[1]?.done,
    ).toBe(true);
  });

  test('the sync step is automatic and says so until tools land', () => {
    const steps = connectorSetupSteps({ ...base, toolCount: 0 });
    expect(steps[2]?.done).toBe(false);
    expect(steps[2]?.hint).toContain('Runs by itself');
    expect(connectorSetupSteps(base)[2]?.hint).toBe('54 tools available.');
  });

  test('a failing sync points back at the reason instead of claiming progress', () => {
    const steps = connectorSetupSteps({ ...base, failing: true });
    expect(steps[2]?.done).toBe(false);
    expect(steps[2]?.hint).toContain('see the reason above');
  });
});
