// Session origin is DERIVED from the caller's token kind + invocation source,
// never the request body, and it gates which override fields a caller may set.
import { describe, expect, test } from 'bun:test';
import {
  type SessionOrigin,
  type SessionOverrideField,
  canOverride,
  resolveSessionOrigin,
} from '../projects/lib/session-origin';

describe('resolveSessionOrigin', () => {
  test('a service-account is backend regardless of surface', () => {
    expect(resolveSessionOrigin({ authType: 'service_account', source: 'ui' })).toBe('backend');
    expect(resolveSessionOrigin({ authType: 'service_account', source: 'cli' })).toBe('backend');
  });

  test('the personal/account API token (pat) is backend — it is the shipped "API key"', () => {
    expect(resolveSessionOrigin({ authType: 'pat', source: 'ui' })).toBe('backend');
    expect(resolveSessionOrigin({ authType: 'pat', source: 'cli' })).toBe('backend');
  });

  test('a customer API key (apiKey + user) is backend', () => {
    expect(resolveSessionOrigin({ authType: 'apiKey', apiKeyType: 'user', source: 'ui' })).toBe(
      'backend',
    );
    expect(resolveSessionOrigin({ authType: 'apiKey', apiKeyType: 'user', source: 'cli' })).toBe(
      'backend',
    );
  });

  test('the INTERNAL sandbox key is never backend (the security-critical exclusion)', () => {
    // The kortix_sb_ KORTIX_TOKEN injected into every sandbox must not let an
    // in-sandbox agent vouch for a phantom end-user via origin_ref.
    expect(resolveSessionOrigin({ authType: 'apiKey', apiKeyType: 'sandbox', source: 'ui' })).toBe(
      'user',
    );
    // POSITIVE apiKeyType==='user' test: a missing/unknown apiKeyType must
    // never be promoted to backend.
    expect(resolveSessionOrigin({ authType: 'apiKey', source: 'ui' })).toBe('user');
    expect(resolveSessionOrigin({ authType: 'apiKey', apiKeyType: null, source: 'ui' })).toBe(
      'user',
    );
  });

  test('an agent-scoped token is never backend, whatever its kind', () => {
    // A token acting AS an agent inside a session is not a customer backend.
    expect(resolveSessionOrigin({ authType: 'pat', agentScoped: true, source: 'cli' })).toBe(
      'user',
    );
    expect(
      resolveSessionOrigin({ authType: 'service_account', agentScoped: true, source: 'ui' }),
    ).toBe('user');
  });

  test('scheduled + triggered invocations are classified by source, not token', () => {
    expect(resolveSessionOrigin({ source: 'trigger:cron' })).toBe('schedule');
    expect(resolveSessionOrigin({ source: 'trigger:webhook' })).toBe('trigger');
    expect(resolveSessionOrigin({ source: 'trigger:manual' })).toBe('trigger');
    // Source wins even if a backend-class token happened to drive the fire.
    expect(resolveSessionOrigin({ authType: 'service_account', source: 'trigger:cron' })).toBe(
      'schedule',
    );
    expect(resolveSessionOrigin({ authType: 'pat', source: 'trigger:webhook' })).toBe('trigger');
  });

  test('internal system flows are system', () => {
    expect(resolveSessionOrigin({ source: 'system:approval-resume' })).toBe('system');
    expect(resolveSessionOrigin({ source: 'system:sandbox-build-fix' })).toBe('system');
  });

  test('a human web/SAML session is user', () => {
    expect(resolveSessionOrigin({ authType: 'supabase', source: 'ui' })).toBe('user');
  });

  test('missing inputs default to the restrictive real-caller class (user)', () => {
    expect(resolveSessionOrigin({})).toBe('user');
    expect(resolveSessionOrigin({ authType: null, source: null })).toBe('user');
  });
});

describe('canOverride', () => {
  const OPEN: SessionOverrideField[] = [
    'connectors',
    'model',
    'agent',
    'runtime_context',
    'skills',
  ];
  const BACKEND_ONLY: SessionOverrideField[] = ['origin_ref', 'secrets'];

  test('backend may override everything', () => {
    for (const f of [...OPEN, ...BACKEND_ONLY]) {
      expect(canOverride('backend', f)).toBe(true);
    }
  });

  test('every non-backend origin keeps the currently-open fields (no regression)', () => {
    for (const origin of ['user', 'trigger', 'schedule', 'system'] as SessionOrigin[]) {
      for (const f of OPEN) {
        expect(canOverride(origin, f)).toBe(true);
      }
    }
  });

  test('only a backend may set origin_ref or a secret bundle', () => {
    for (const origin of ['user', 'trigger', 'schedule', 'system'] as SessionOrigin[]) {
      expect(canOverride(origin, 'origin_ref')).toBe(false);
      expect(canOverride(origin, 'secrets')).toBe(false);
    }
  });
});
