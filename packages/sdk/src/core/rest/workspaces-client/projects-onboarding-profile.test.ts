import { beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { setWorkspaceOnboardingProfile } from './workspaces';

let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify({ workspace_id: 'p1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 't' });
});

test('PATCHes the onboarding route with a profile envelope', async () => {
  await setWorkspaceOnboardingProfile('p1', { use_case: 'sales', company_size: '51-200' });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('PATCH');
  expect(calls[0]?.url).toContain('/workspaces/p1/onboarding');
  expect(calls[0]?.body).toEqual({ profile: { use_case: 'sales', company_size: '51-200' } });
});

// Completion is a separate lifecycle write (`setWorkspaceOnboardingComplete`).
// Leaking a `completed` flag out of a survey save would end onboarding the
// moment the user answered the first question.
test('never sends a completed flag', async () => {
  await setWorkspaceOnboardingProfile('p1', { company_domain: 'acme.com' });

  expect(calls[0]?.body).toEqual({ profile: { company_domain: 'acme.com' } });
  expect(JSON.stringify(calls[0]?.body)).not.toContain('completed');
});

// Onboarding saves each answer as it is given, so a one-field profile is the
// normal case, not an error case.
test('accepts a partial profile', async () => {
  await setWorkspaceOnboardingProfile('p1', { use_case: 'engineering' });

  expect(calls[0]?.body).toEqual({ profile: { use_case: 'engineering' } });
});
