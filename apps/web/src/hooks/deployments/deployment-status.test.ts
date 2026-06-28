import { describe, expect, test } from 'bun:test';
import { isDeploymentInProgress, shouldPollDeployments } from './deployment-status';

describe('isDeploymentInProgress', () => {
  test('treats pending/building/deploying as in progress', () => {
    expect(isDeploymentInProgress('pending')).toBe(true);
    expect(isDeploymentInProgress('building')).toBe(true);
    expect(isDeploymentInProgress('deploying')).toBe(true);
  });

  test('treats active/failed/stopped as settled', () => {
    expect(isDeploymentInProgress('active')).toBe(false);
    expect(isDeploymentInProgress('failed')).toBe(false);
    expect(isDeploymentInProgress('stopped')).toBe(false);
  });
});

describe('shouldPollDeployments', () => {
  test('polls while any deployment is in progress', () => {
    expect(shouldPollDeployments([{ status: 'active' }, { status: 'building' }])).toBe(true);
  });

  test('stops polling when all deployments are settled', () => {
    expect(shouldPollDeployments([{ status: 'active' }, { status: 'failed' }, { status: 'stopped' }])).toBe(
      false,
    );
  });

  test('does not poll for empty/undefined/null lists', () => {
    expect(shouldPollDeployments([])).toBe(false);
    expect(shouldPollDeployments(undefined)).toBe(false);
    expect(shouldPollDeployments(null)).toBe(false);
  });
});
