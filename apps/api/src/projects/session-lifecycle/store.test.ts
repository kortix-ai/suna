import { describe, expect, test } from 'bun:test';
import { createSessionCommandPayload } from './store';
import type { CreateSessionCommand } from './types';

const BASE: CreateSessionCommand = {
  source: 'ui',
  project: {} as CreateSessionCommand['project'],
  userId: 'user-1',
  requestingPrincipalType: 'human',
  body: { initial_prompt: 'hi', origin_ref: 'tenant-42' },
};

describe('createSessionCommandPayload', () => {
  test('carries the origin-derivation signals through the queue', () => {
    const payload = createSessionCommandPayload({
      ...BASE,
      authType: 'pat',
      apiKeyType: 'user',
      inSession: false,
    });
    expect(payload.authType).toBe('pat');
    expect(payload.apiKeyType).toBe('user');
    expect(payload.inSession).toBe(false);
    expect(payload.body).toEqual({ initial_prompt: 'hi', origin_ref: 'tenant-42' });
  });

  test('absent signals stay absent (pre-origin queued rows replay as user)', () => {
    const payload = createSessionCommandPayload(BASE);
    expect(payload.authType).toBeUndefined();
    expect(payload.apiKeyType).toBeUndefined();
    expect(payload.inSession).toBeUndefined();
  });
});
