// Which credential names a person who follows a trigger (KRTX-1742). Who an
// alert reaches runs against real PostgreSQL in
// src/__tests__/integration-trigger-alerts.test.ts.
import { describe, expect, test } from 'bun:test';
import { triggerWatcherOf } from './trigger-watchers';

const PERSON = '6b100000-0000-4000-a000-000000000001';
const OTHER = '6b200000-0000-4000-a000-000000000001';

describe('triggerWatcherOf', () => {
  test.each([
    ['a browser or app sign-in', { authType: 'supabase', userId: PERSON, sessionId: OTHER }, PERSON],
    ['a personal CLI token', { authType: 'pat', userId: PERSON, sessionId: null }, PERSON],
    ['an agent session token acting for a person', { authType: 'pat', userId: OTHER, sessionId: OTHER, onBehalfOfUserId: PERSON }, PERSON],
    ['an unattended agent session token', { authType: 'pat', userId: OTHER, sessionId: OTHER, onBehalfOfUserId: null }, null],
    ['an account API key', { authType: 'apiKey', userId: OTHER }, null],
    ['a service account', { authType: 'service_account', userId: OTHER }, null],
    ['an OAuth client', { authType: 'oauth', userId: OTHER }, null],
    ['no credential', {}, null],
  ] as const)('%s', (_name, credential, expected) => {
    expect(triggerWatcherOf(credential)).toBe(expected);
  });
});
