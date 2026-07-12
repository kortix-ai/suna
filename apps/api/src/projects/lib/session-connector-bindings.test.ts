import { describe, expect, test } from 'bun:test';
import { resolveTokenBoundSessionId } from '../../executor/db-deps';
import {
  canonicalConnectorAlias,
  connectorBindingPayloadConflicts,
  mayUseLegacyDefaultProfile,
  parseSessionConnectorBindings,
} from './session-connector-bindings';

describe('session connector binding security contracts', () => {
  const profileA = '11111111-1111-4111-a111-111111111111';
  const profileB = '22222222-2222-4222-a222-222222222222';

  test('idempotent replay accepts reordered identical bindings and conflicts on profile swap', () => {
    expect(
      connectorBindingPayloadConflicts(
        { email: { profile_id: profileA }, veyris: { profile_id: profileB } },
        { veyris: { profile_id: profileB }, email: { profile_id: profileA } },
      ),
    ).toBe(false);
    expect(
      connectorBindingPayloadConflicts(
        { veyris: { profile_id: profileA } },
        { veyris: { profile_id: profileB } },
      ),
    ).toBe(true);
  });

  test('public email alias canonicalizes and binding input stays typed', () => {
    expect(canonicalConnectorAlias('email')).toBe('kortix_email');
    expect(parseSessionConnectorBindings({ email: { profile_id: profileA } }).ok).toBe(true);
    expect(parseSessionConnectorBindings({ email: { profile_id: profileA, token: 'no' } }).ok).toBe(
      false,
    );
  });

  test('caller header can never replace authenticated session identity', () => {
    expect(resolveTokenBoundSessionId('session-a', 'session-a')).toEqual({
      ok: true,
      sessionId: 'session-a',
    });
    expect(resolveTokenBoundSessionId('session-a', 'session-b')).toEqual({ ok: false });
    expect(resolveTokenBoundSessionId(null, 'session-b')).toEqual({ ok: false });
  });

  test('legacy defaults are allowed only when the session has zero durable bindings', () => {
    expect(mayUseLegacyDefaultProfile(false)).toBe(true);
    expect(mayUseLegacyDefaultProfile(true)).toBe(false);
  });
});
