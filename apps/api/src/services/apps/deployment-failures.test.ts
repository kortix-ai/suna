import { describe, expect, test } from 'bun:test';
import { appDeploymentFailureDisposition } from './deployment-failures';

describe('appDeploymentFailureDisposition', () => {
  test('does not retry deterministic Dockerfile build failures', () => {
    expect(appDeploymentFailureDisposition(
      'Snapshot build failed: process "/bin/sh -c exit 42" did not complete successfully: exit code: 42',
    )).toEqual({ permanent: true, code: 'dockerfile_build_failed' });
  });

  test('retries provider, quota, timeout, and unknown infrastructure failures', () => {
    expect(appDeploymentFailureDisposition('Daytona bad gateway')).toEqual({
      permanent: false,
      code: 'provider_error',
    });
    expect(appDeploymentFailureDisposition('snapshot quota reached')).toEqual({
      permanent: false,
      code: 'quota',
    });
    expect(appDeploymentFailureDisposition('build timed out')).toEqual({
      permanent: false,
      code: 'timeout',
    });
    expect(appDeploymentFailureDisposition('unclassified failure')).toEqual({
      permanent: false,
      code: 'deployment_failed',
    });
  });
});
