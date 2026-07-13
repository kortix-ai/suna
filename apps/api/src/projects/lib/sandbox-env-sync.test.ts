import { describe, expect, test } from 'bun:test';

import { KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import { buildEnvSyncHeaders } from './sandbox-env-sync';

describe('buildEnvSyncHeaders', () => {
  test('keeps provider ingress credentials but strips user context from the internal env route', () => {
    const headers = buildEnvSyncHeaders({
      providerHeaders: {
        'X-Daytona-Preview-Token': 'provider-token',
        [KORTIX_USER_CONTEXT_HEADER.toLowerCase()]: 'signed-user-context',
        Authorization: 'Bearer user-scoped-value',
      },
      serviceKey: 'sandbox-service-key',
    });

    expect(headers.get('X-Daytona-Preview-Token')).toBe('provider-token');
    expect(headers.get(KORTIX_USER_CONTEXT_HEADER)).toBeNull();
    expect(headers.get('Authorization')).toBe('Bearer sandbox-service-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});
