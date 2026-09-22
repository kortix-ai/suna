import { describe, expect, test } from 'bun:test';

describe('isProjectLimitError', () => {
  test('true for the project_limit_reached code in the message', async () => {
    const { isProjectLimitError } = await import('./provision-errors');
    expect(isProjectLimitError(new Error('project_limit_reached'))).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isProjectLimitError } = await import('./provision-errors');
    expect(isProjectLimitError(new Error('network error'))).toBe(false);
  });
});

describe('isManagedGitUnavailableError', () => {
  test('true for a 503-status error', async () => {
    const { isManagedGitUnavailableError } = await import('./provision-errors');
    const err = new Error('nope');
    (err as Error & { status: number }).status = 503;
    expect(isManagedGitUnavailableError(err)).toBe(true);
  });

  test('true for the not-configured message with no status', async () => {
    const { isManagedGitUnavailableError } = await import('./provision-errors');
    expect(
      isManagedGitUnavailableError(
        new Error('Managed git provider "github" is not configured on this server'),
      ),
    ).toBe(true);
  });

  test('false for an unrelated error', async () => {
    const { isManagedGitUnavailableError } = await import('./provision-errors');
    expect(isManagedGitUnavailableError(new Error('network error'))).toBe(false);
  });
});

describe('isProvisionInFlightError', () => {
  test('true for a 409 with code provision_in_flight', async () => {
    const { isProvisionInFlightError } = await import('./provision-errors');
    const err = Object.assign(
      new Error('Another provision with this idempotency_key is in flight'),
      {
        status: 409,
        code: 'provision_in_flight',
      },
    );
    expect(isProvisionInFlightError(err)).toBe(true);
  });

  test('true for the message with no code (plain Error, status 409)', async () => {
    const { isProvisionInFlightError } = await import('./provision-errors');
    const err = Object.assign(
      new Error('Another provision with this idempotency_key is in flight'),
      { status: 409 },
    );
    expect(isProvisionInFlightError(err)).toBe(true);
  });

  test('false for an unrelated 409', async () => {
    const { isProvisionInFlightError } = await import('./provision-errors');
    const err = Object.assign(new Error('conflict'), { status: 409, code: 'some_other_conflict' });
    expect(isProvisionInFlightError(err)).toBe(false);
  });

  test('false for an unrelated error', async () => {
    const { isProvisionInFlightError } = await import('./provision-errors');
    expect(isProvisionInFlightError(new Error('network error'))).toBe(false);
  });
});
